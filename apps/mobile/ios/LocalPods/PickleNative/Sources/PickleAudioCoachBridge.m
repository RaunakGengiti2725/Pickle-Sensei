#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(PickleAudioCoach, NSObject)

RCT_EXTERN_METHOD(speak:(NSString *)text rate:(double)rate)
RCT_EXTERN_METHOD(stop)

@end
