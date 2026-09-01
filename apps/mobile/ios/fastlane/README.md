fastlane documentation
----

# Installation

Make sure you have the latest version of the Xcode command line tools installed:

```sh
xcode-select --install
```

For _fastlane_ installation instructions, see [Installing _fastlane_](https://docs.fastlane.tools/#installing-fastlane)

# Available Actions

## iOS

### ios build

```sh
[bundle exec] fastlane ios build
```

Build a signed release archive (Mac-only)

### ios prep_signing

```sh
[bundle exec] fastlane ios prep_signing
```

Create/refresh the local Apple Distribution certificate + App Store
profile via the ASC API (Mac-only). Needed once per Mac: cloud-managed
signing certificates require an Admin API key, while classic cert+profile
creation works with the App Manager key this repo uses.

### ios beta

```sh
[bundle exec] fastlane ios beta
```

Bump build number, build, and upload to TestFlight internal testing (Mac-only)

### ios release

```sh
[bundle exec] fastlane ios release
```

Build and upload the App Store release binary (Mac-only). Uploads the
binary ONLY — metadata, screenshots, pricing, and the actual submission to
App Review stay deliberate manual steps in App Store Connect.

---

This README.md is auto-generated and will be re-generated every time [_fastlane_](https://fastlane.tools) is run.

More information about _fastlane_ can be found on [fastlane.tools](https://fastlane.tools).

The documentation of _fastlane_ can be found on [docs.fastlane.tools](https://docs.fastlane.tools).
