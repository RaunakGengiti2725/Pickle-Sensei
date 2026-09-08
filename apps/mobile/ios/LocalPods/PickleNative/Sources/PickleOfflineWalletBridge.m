#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(PickleOfflineWallet, NSObject)

RCT_EXTERN_METHOD(loadWallet:(NSString *)ownerId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(replaceWallet:(NSString *)ownerId
                  expectedRevision:(nonnull NSNumber *)expectedRevision
                  contents:(NSDictionary *)contents
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(clearWallet:(NSString *)ownerId
                  expectedRevision:(nonnull NSNumber *)expectedRevision
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(discardCorruptWallet:(NSString *)ownerId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
