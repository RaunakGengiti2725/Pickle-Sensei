#import <React/RCTViewManager.h>

@interface RCT_EXTERN_REMAP_MODULE(PickleClipPlayerView, PickleClipPlayerViewManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(sourceUri, NSString)
RCT_EXPORT_VIEW_PROPERTY(playing, BOOL)
RCT_EXPORT_VIEW_PROPERTY(seekMs, double)
RCT_EXPORT_VIEW_PROPERTY(resizeMode, NSString)
RCT_EXPORT_VIEW_PROPERTY(rate, double)
RCT_EXPORT_VIEW_PROPERTY(onClipProgress, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onClipLoad, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onClipEnd, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onClipError, RCTDirectEventBlock)

@end
