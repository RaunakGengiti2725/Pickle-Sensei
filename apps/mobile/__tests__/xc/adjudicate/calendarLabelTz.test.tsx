/**
 * Adjudication reproduction (xc-journeys / journey-progress-streaks): the
 * StreakCalendarScreen day-detail heading and the AchievementsShowcase
 * "Earned <date>" label format `new Date(`${day}T12:00:00Z`)` in the DEVICE
 * time zone. Any zone at UTC+12:01 or beyond (Pacific/Auckland during DST,
 * Tonga, Tokelau, Kiritimati, Apia) sees 12:00Z as 00:xx–02:00 of the NEXT
 * calendar day, so the label names a different day than the engine day key
 * (which the day cell exposes to assistive tech).
 *
 * Run with TZ=Pacific/Auckland (jest inherits the process zone).
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { AchievementsShowcase } from '../../../src/consistency/AchievementsShowcase';
import { buildConsistencySnapshot } from '../../../src/consistency/engine';

declare const process: { env: Record<string, string | undefined> };

const ZONE = 'Pacific/Auckland';
// Southern-summer dates: Auckland is UTC+13.
const ENGINE_OPTIONS = { asOfIso: '2026-01-15T05:00:00.000Z', timeZone: ZONE };

describe(`adjudication: calendar day labels in TZ=${process.env['TZ']}`, () => {
  it('names the engine day key in the "Earned" label', () => {
    expect(process.env['TZ']).toBe(ZONE);
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(ZONE);
    const snapshot = buildConsistencySnapshot(
      ['2026-01-13', '2026-01-14', '2026-01-15'].map(day => ({
        kind: 'stroke' as const,
        // 18:00 Auckland local = 05:00Z same day.
        atIso: `${day}T05:00:00.000Z`,
        shotType: 'dink',
        overallScore: 7,
        resultKind: 'scored' as const,
      })),
      ENGINE_OPTIONS,
    );
    expect(snapshot.asOfDay).toBe('2026-01-15');
    const kindling = snapshot.earned.find(e => e.id === 'streak.3');
    expect(kindling?.earnedOnDay).toBe('2026-01-15');

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <AchievementsShowcase snapshot={snapshot} />,
      );
    });
    const label = renderer.root
      .findAll(
        node =>
          typeof node.props.accessibilityLabel === 'string' &&
          node.props.accessibilityLabel.startsWith('Kindling. Earned'),
      )
      .map(node => String(node.props.accessibilityLabel))[0];
    const heading = new Date('2026-01-15T12:00:00Z').toLocaleDateString(
      undefined,
      {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      },
    );
    act(() => renderer.unmount());

    console.log(
      `[adjudicate] TZ=${ZONE} engineDay=2026-01-15 earnedLabel="${label}" dayDetailHeading="${heading}"`,
    );
    expect(Text).toBeDefined();
    // Expected product behaviour: the label names the engine day (Jan 15).
    expect(label).toBe('Kindling. Earned Jan 15');
    expect(heading).toBe('Thursday, January 15');
  });
});
