#import <React/RCTViewManager.h>

@interface RCT_EXTERN_REMAP_MODULE(PickleSessionPreviewView, PickleSessionPreviewViewManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(sessionCaptureId, NSString)
RCT_EXPORT_VIEW_PROPERTY(onPreviewState, RCTDirectEventBlock)

@end
