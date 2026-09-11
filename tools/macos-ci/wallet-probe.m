// In-process wallet probe for tools/macos-ci/wallet-persistence-check.sh.
//
// The shipping app never exposes its native offline wallet to anything but
// its own JavaScript, so simulator evidence of "store -> force-quit ->
// restore" has to come from inside the app process: only there do Keychain
// calls run under the app's ad-hoc signature, entitlements and application
// identifier. The helper compiles this file for the iOS Simulator SDK, signs
// it ad hoc and injects it into the installed PickleSensei.app through
// SIMCTL_CHILD_DYLD_INSERT_LIBRARIES. Nothing here is linked into the product.
//
// The probe talks to the real React Native module class `PickleOfflineWallet`
// (apps/mobile/ios/LocalPods/PickleNative/Sources/PickleOfflineWallet.swift)
// through its exported Objective-C selectors, exactly as the bridge would, so
// the bytes that reach the Keychain are the product's own sealed envelopes.
//
// Environment (set by the helper, forwarded by `simctl launch`):
//   PICKLE_WALLET_PROBE_PHASE   store | restore
//   PICKLE_WALLET_PROBE_OWNER   canonical owner id the wallet is kept for
//   PICKLE_WALLET_PROBE_INPUT   store phase: JSON {grants, receipts} to store
//   PICKLE_WALLET_PROBE_RESULT  path the phase result JSON is written to
//
// store:   load (recovering from unreadable leftover state through
//          discardCorrupt), replace at the loaded revision, report the
//          snapshot the module returned.
// restore: load, report the snapshot, clear it at its revision, load again
//          and report that the slot reads as "no wallet".
//
// Without a phase in the environment the probe stays inactive. Each result is
// written atomically (temporary file + rename) so the helper never reads a
// partial document; every step is also logged with the `PickleWalletProbe`
// tag so the unified log captured beside the screenshots carries the trail.
#import <Foundation/Foundation.h>
#import <errno.h>
#import <stdio.h>
#import <stdlib.h>
#import <unistd.h>

typedef void (^PickleProbeResolve)(id result);
typedef void (^PickleProbeReject)(NSString *code, NSString *message, NSError *error);

@protocol PickleOfflineWalletModule <NSObject>
- (void)loadWallet:(NSString *)ownerId
          resolver:(PickleProbeResolve)resolve
          rejecter:(PickleProbeReject)reject;
- (void)replaceWallet:(NSString *)ownerId
     expectedRevision:(NSNumber *)expectedRevision
             contents:(NSDictionary *)contents
             resolver:(PickleProbeResolve)resolve
             rejecter:(PickleProbeReject)reject;
- (void)clearWallet:(NSString *)ownerId
   expectedRevision:(NSNumber *)expectedRevision
           resolver:(PickleProbeResolve)resolve
           rejecter:(PickleProbeReject)reject;
- (void)discardCorruptWallet:(NSString *)ownerId
                    resolver:(PickleProbeResolve)resolve
                    rejecter:(PickleProbeReject)reject;
@end

static NSString *const kProbeTag = @"PickleWalletProbe";
static const int64_t kCallTimeoutSeconds = 20;

static NSString *envString(const char *name) {
  const char *value = getenv(name);
  if (value == NULL || value[0] == '\0') {
    return nil;
  }
  return [NSString stringWithUTF8String:value];
}

// One bridge call as JSON-ready state: {"resolved": value-or-null},
// {"rejected": {"code", "message", "status"}} or {"timeout": true}.
static NSDictionary *awaitCall(void (^call)(PickleProbeResolve resolve, PickleProbeReject reject)) {
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  __block NSDictionary *outcome = nil;
  call(
      ^(id result) {
        outcome = @{@"resolved" : result ?: [NSNull null]};
        dispatch_semaphore_signal(done);
      },
      ^(NSString *code, NSString *message, NSError *error) {
        outcome = @{
          @"rejected" : @{
            @"code" : code ?: @"",
            @"message" : message ?: @"",
            @"status" : @(error != nil ? error.code : 0),
          }
        };
        dispatch_semaphore_signal(done);
      });
  if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, kCallTimeoutSeconds * NSEC_PER_SEC)) != 0) {
    return @{@"timeout" : @YES};
  }
  return outcome;
}

static NSDictionary *resolvedDictionary(NSDictionary *outcome) {
  id value = outcome[@"resolved"];
  return [value isKindOfClass:[NSDictionary class]] ? value : nil;
}

static BOOL resolvedEmpty(NSDictionary *outcome) {
  id value = outcome[@"resolved"];
  return value != nil && value == [NSNull null];
}

static NSString *describeFailure(NSDictionary *outcome, NSString *fallback) {
  NSString *code = outcome[@"rejected"][@"code"];
  if (code.length > 0) {
    return code;
  }
  if ([outcome[@"timeout"] boolValue]) {
    return @"timeout";
  }
  return fallback;
}

static BOOL isUnreadableStateCode(NSString *code) {
  return [code isEqualToString:@"wallet.tampered"] || [code isEqualToString:@"wallet.integrity_key_missing"] ||
         [code isEqualToString:@"wallet.unsupported_version"];
}

static void writeResult(NSString *path, NSDictionary *result) {
  NSError *error = nil;
  NSData *json = [NSJSONSerialization dataWithJSONObject:result
                                                 options:(NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys)
                                                   error:&error];
  if (json == nil) {
    NSLog(@"%@ result is not serialisable: %@", kProbeTag, error);
    return;
  }
  NSString *temporary = [path stringByAppendingString:@".tmp"];
  if (![json writeToFile:temporary options:NSDataWritingAtomic error:&error]) {
    NSLog(@"%@ could not write %@: %@", kProbeTag, temporary, error);
    return;
  }
  if (rename(temporary.fileSystemRepresentation, path.fileSystemRepresentation) != 0) {
    NSLog(@"%@ could not publish %@: errno %d", kProbeTag, path, errno);
    return;
  }
  NSLog(@"%@ phase=%@ ok=%@ result=%@", kProbeTag, result[@"phase"], result[@"ok"], path);
}

static NSDictionary *readContents(NSString *path, NSString **failure) {
  if (path == nil) {
    *failure = @"PICKLE_WALLET_PROBE_INPUT is not set";
    return nil;
  }
  NSError *error = nil;
  NSData *data = [NSData dataWithContentsOfFile:path options:0 error:&error];
  if (data == nil) {
    *failure = [NSString stringWithFormat:@"input unreadable: %@", error.localizedDescription];
    return nil;
  }
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
  if (![parsed isKindOfClass:[NSDictionary class]]) {
    *failure = [NSString stringWithFormat:@"input is not a JSON object: %@", error.localizedDescription ?: @""];
    return nil;
  }
  return parsed;
}

static void runStore(id<PickleOfflineWalletModule> wallet, NSString *owner, NSMutableDictionary *result) {
  NSString *failure = nil;
  NSDictionary *contents = readContents(envString("PICKLE_WALLET_PROBE_INPUT"), &failure);
  if (contents == nil) {
    result[@"failure"] = failure;
    return;
  }
  NSDictionary *loaded = awaitCall(^(PickleProbeResolve resolve, PickleProbeReject reject) {
    [wallet loadWallet:owner resolver:resolve rejecter:reject];
  });
  NSString *loadCode = loaded[@"rejected"][@"code"];
  if (loadCode != nil && isUnreadableStateCode(loadCode)) {
    // Leftover CI state from an interrupted run is retired the way the product
    // would after reconciliation; the retirement stays in the record.
    result[@"discarded"] = awaitCall(^(PickleProbeResolve resolve, PickleProbeReject reject) {
      [wallet discardCorruptWallet:owner resolver:resolve rejecter:reject];
    });
    NSLog(@"%@ store: discarded unreadable leftover state (%@)", kProbeTag, loadCode);
    loaded = awaitCall(^(PickleProbeResolve resolve, PickleProbeReject reject) {
      [wallet loadWallet:owner resolver:resolve rejecter:reject];
    });
  }
  result[@"loaded"] = loaded;
  NSDictionary *previous = resolvedDictionary(loaded);
  if (previous == nil && !resolvedEmpty(loaded)) {
    result[@"failure"] = describeFailure(loaded, @"load before store did not resolve");
    return;
  }
  NSNumber *expectedRevision = previous[@"revision"] ?: @0;
  NSLog(@"%@ store: loaded revision %@, replacing", kProbeTag, expectedRevision);
  NSDictionary *replaced = awaitCall(^(PickleProbeResolve resolve, PickleProbeReject reject) {
    [wallet replaceWallet:owner expectedRevision:expectedRevision contents:contents resolver:resolve rejecter:reject];
  });
  result[@"replaced"] = replaced;
  NSDictionary *stored = resolvedDictionary(replaced);
  if (stored == nil) {
    result[@"failure"] = describeFailure(replaced, @"replace did not resolve to a snapshot");
    return;
  }
  result[@"stored"] = stored;
  result[@"ok"] = @YES;
  NSLog(@"%@ store: wallet revision %@ written for owner %@", kProbeTag, stored[@"revision"], owner);
}

static void runRestore(id<PickleOfflineWalletModule> wallet, NSString *owner, NSMutableDictionary *result) {
  NSDictionary *loaded = awaitCall(^(PickleProbeResolve resolve, PickleProbeReject reject) {
    [wallet loadWallet:owner resolver:resolve rejecter:reject];
  });
  result[@"loaded"] = loaded;
  NSDictionary *restored = resolvedDictionary(loaded);
  if (restored == nil) {
    result[@"failure"] = describeFailure(loaded, resolvedEmpty(loaded) ? @"no wallet stored" : @"load did not resolve");
    return;
  }
  result[@"restored"] = restored;
  NSNumber *revision = restored[@"revision"] ?: @0;
  NSLog(@"%@ restore: wallet revision %@ read back for owner %@", kProbeTag, revision, owner);
  NSDictionary *cleared = awaitCall(^(PickleProbeResolve resolve, PickleProbeReject reject) {
    [wallet clearWallet:owner expectedRevision:revision resolver:resolve rejecter:reject];
  });
  result[@"cleared"] = cleared;
  if (!resolvedEmpty(cleared)) {
    result[@"failure"] = describeFailure(cleared, @"clear did not resolve");
    return;
  }
  NSDictionary *afterClear = awaitCall(^(PickleProbeResolve resolve, PickleProbeReject reject) {
    [wallet loadWallet:owner resolver:resolve rejecter:reject];
  });
  result[@"afterClear"] = afterClear;
  if (!resolvedEmpty(afterClear)) {
    result[@"failure"] = describeFailure(afterClear, @"slot still holds a wallet after clear");
    return;
  }
  result[@"ok"] = @YES;
  NSLog(@"%@ restore: wallet cleared at revision %@, slot reads empty", kProbeTag, revision);
}

static void runProbe(void) {
  NSString *phase = envString("PICKLE_WALLET_PROBE_PHASE");
  NSString *owner = envString("PICKLE_WALLET_PROBE_OWNER");
  NSString *resultPath = envString("PICKLE_WALLET_PROBE_RESULT");
  if (phase == nil || owner == nil || resultPath == nil) {
    NSLog(@"%@ inactive: phase, owner and result path are all required", kProbeTag);
    return;
  }
  NSMutableDictionary *result = [NSMutableDictionary dictionaryWithDictionary:@{
    @"phase" : phase,
    @"ownerId" : owner,
    @"pid" : @(getpid()),
    @"bundleId" : NSBundle.mainBundle.bundleIdentifier ?: @"",
    @"osVersion" : NSProcessInfo.processInfo.operatingSystemVersionString,
    @"ok" : @NO,
  }];
  Class moduleClass = NSClassFromString(@"PickleOfflineWallet");
  if (moduleClass == Nil) {
    result[@"failure"] = @"PickleOfflineWallet is not linked into this app";
    writeResult(resultPath, result);
    return;
  }
  id<PickleOfflineWalletModule> wallet = [[moduleClass alloc] init];
  if ([phase isEqualToString:@"store"]) {
    runStore(wallet, owner, result);
  } else if ([phase isEqualToString:@"restore"]) {
    runRestore(wallet, owner, result);
  } else {
    result[@"failure"] = [NSString stringWithFormat:@"unknown phase %@", phase];
  }
  writeResult(resultPath, result);
}

__attribute__((constructor)) static void PickleWalletProbeStart(void) {
  if (envString("PICKLE_WALLET_PROBE_PHASE") == nil) {
    return;
  }
  NSLog(@"%@ loaded into pid %d", kProbeTag, getpid());
  // Let the app's own launch proceed first; the wallet module serialises its
  // own work, so the probe never needs the React Native bridge to be up.
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1 * NSEC_PER_SEC)),
                 dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
                   runProbe();
                 });
}
