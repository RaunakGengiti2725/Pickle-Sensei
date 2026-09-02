import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)
    window?.backgroundColor = .launchCanvas

    factory.startReactNative(
      withModuleName: "PickleSensei",
      in: window,
      launchOptions: launchOptions
    )

    // Until the first JS frame renders, React's root view shows this color.
    // It matches the launch storyboard and the first frame of the JS intro
    // video, so storyboard → root view → intro is one continuous surface.
    window?.rootViewController?.view.backgroundColor = .launchCanvas

    return true
  }
}

private extension UIColor {
  /// Mirrors the intro video's white edges (`SplashScreen.tsx` CANVAS) and
  /// the LaunchScreen.storyboard background.
  static let launchCanvas = UIColor.white
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
