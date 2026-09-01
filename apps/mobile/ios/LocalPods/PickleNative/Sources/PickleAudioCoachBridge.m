#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(PickleAudioCoach, NSObject)

RCT_EXTERN_METHOD(speak:(NSString *)text rate:(double)rate)
RCT_EXTERN_METHOD(speakCue:(NSString *)text options:(NSDictionary *)options)
RCT_EXTERN_METHOD(listVoices:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(stop)

@end
