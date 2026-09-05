import Foundation
import XCTest
import PickleNativeStressKit

/// Shared driver for the seeded campaigns. `STRESS_ITER` (default 25) sets the
/// seeds per scenario so the suite stays fast by default; the full campaign is
/// `STRESS_ITER=1000 swift test` or `scripts/campaign.py`.
enum StressCampaign {
  static var iterations: Int { StressScenario.defaultIterations }

  /// Runs `scenario` for seeds `start ..< start+count` and fails the test on
  /// the FIRST violated seed with the exact replay command.
  static func assertHeld(
    _ scenario: StressScenario,
    seedStart: UInt64 = 1,
    count: Int? = nil,
    file: StaticString = #filePath,
    line: UInt = #line
  ) -> [StressOutcome] {
    let total = count ?? scenario.campaignIterations()
    var outcomes: [StressOutcome] = []
    outcomes.reserveCapacity(total)
    for offset in 0 ..< UInt64(total) {
      let seed = seedStart &+ offset
      let outcome = scenario.run(seed: seed)
      outcomes.append(outcome)
      if !outcome.held {
        XCTFail(
          "\(scenario.rawValue) seed \(seed): \(outcome.detail ?? "violated") — replay: "
            + "swift run stress-runner replay --scenario \(scenario.rawValue) --seed \(seed)",
          file: file,
          line: line
        )
        break
      }
    }
    return outcomes
  }
}
