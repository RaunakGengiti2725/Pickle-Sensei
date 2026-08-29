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
    window?.backgroundColor = .brandSurfaceDark

    factory.startReactNative(
      withModuleName: "PickleSensei",
      in: window,
      launchOptions: launchOptions
    )

    // React's root view is white until the first JS frame renders. Painting it
    // with the launch background keeps the handoff from the launch storyboard
    // to the JS splash from flashing white.
    window?.rootViewController?.view.backgroundColor = .brandSurfaceDark

    return true
  }
}

private extension UIColor {
  /// Mirrors `color.surfaceDark` (#06130E) in the JS design tokens.
  static let brandSurfaceDark = UIColor(
    red: 6.0 / 255.0,
    green: 19.0 / 255.0,
    blue: 14.0 / 255.0,
    alpha: 1.0
  )
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
