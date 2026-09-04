// Minimal stand-in for the two React Native symbols that
// apps/mobile/ios/LocalPods/PickleNative/Sources/PickleSessionPreview.swift
// imports from `React`. Shapes mirror the RN 0.87 headers:
//   RCTComponent.h:   typedef void (^RCTDirectEventBlock)(NSDictionary *body);
//   RCTViewManager.h: @interface RCTViewManager : NSObject <RCTBridgeModule>
//                     - (UIView *)view;
//   RCTBridgeModule.h: + (BOOL)requiresMainQueueSetup;
// Nothing here is exercised by the tests beyond letting the production view
// compile; the RN bridge (event dispatch, prop setting) is out of scope.
import UIKit

public typealias RCTDirectEventBlock = ([AnyHashable: Any]?) -> Void

open class RCTViewManager: NSObject {
  public override init() { super.init() }
  open func view() -> UIView! { nil }
  open class func requiresMainQueueSetup() -> Bool { false }
}
