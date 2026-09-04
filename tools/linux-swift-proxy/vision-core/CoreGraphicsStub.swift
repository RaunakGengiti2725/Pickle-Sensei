// Linux stand-in for the `CoreGraphics` module: Foundation on Linux already
// defines CGPoint/CGFloat, so re-exporting it is all a test that writes
// `import CoreGraphics` needs to compile unchanged.
@_exported import Foundation
