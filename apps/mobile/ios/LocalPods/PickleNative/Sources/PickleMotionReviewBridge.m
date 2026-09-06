#import <React/RCTViewManager.h>

@interface RCT_EXTERN_REMAP_MODULE(PickleMotionReviewView, PickleMotionReviewViewManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(artifactJson, NSString)
RCT_EXPORT_VIEW_PROPERTY(artifactSha256, NSString)
RCT_EXPORT_VIEW_PROPERTY(videoUri, NSString)
RCT_EXPORT_VIEW_PROPERTY(command, NSDictionary)
RCT_EXPORT_VIEW_PROPERTY(onReviewReady, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onReviewProgress, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onReviewError, RCTDirectEventBlock)

@end
