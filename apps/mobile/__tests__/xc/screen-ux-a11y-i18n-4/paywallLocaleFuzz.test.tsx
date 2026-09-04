/**
 * xc-screen-ux-a11y-i18n-4 — PaywallScreen price / locale fuzz.
 *
 * Adversarial, seeded property test over the pricing page. Each seed builds a
 * StorePlans fixture the way the store SDK would hand it back for a random
 * locale + currency (Intl-formatted `priceString` / `pricePerMonthString`,
 * random plan subset, random trial, random price ratios) and asserts the
 * paywall is a pure pass-through of the store strings:
 *
 *   - every store `priceString` appears verbatim in its own column, in that
 *     column's VoiceOver label, in the Continue CTA (unless a free trial owns
 *     the CTA) and in the legal restatement once selected;
 *   - the yearly column's monthly-equivalent is the store's
 *     `pricePerMonthString`, never a client division;
 *   - no currency symbol and no "price-looking" digit run is rendered that the
 *     store did not supply (catches hardcoded "$", client-side math, or a
 *     column falling back to another plan's price);
 *   - the SAVE badge appears iff the numeric store prices justify it, with the
 *     percentage the spec defines, and never when monthly is missing/zero or
 *     yearly is not cheaper;
 *   - a missing plan produces no column and no invented price; a store failure
 *     renders the honest unavailable state with retry and zero prices.
 *
 * Failures print the seed + the exact fixture so they replay with
 * `XC_SEED_ONLY=<seed> npx jest paywallLocaleFuzz`. The full per-seed table is
 * written to artifacts/xc-screen-ux-a11y-i18n-4/paywall-locale-fuzz.json.
 */
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const fs = require('fs') as {
  mkdirSync: (dir: string, opts: { recursive: boolean }) => void;
  writeFileSync: (file: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

jest.mock('react-native-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  initialWindowMetrics: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
}));
jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Line: Mock,
    Path: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
  };
});

import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type {
  BillingAccessDependencies,
  BillingPeriod,
  CanonicalAccessState,
  StorePlan,
  StorePlans,
} from '../../../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../../src/state/accessStore';
import { PaywallScreen } from '../../../src/screens/PaywallScreen';

const ARTIFACT_DIR =
  process.env.XC_ARTIFACT_DIR ??
  path.resolve(__dirname, '../../../../../artifacts/xc-screen-ux-a11y-i18n-4');
const SEED_COUNT = Number(process.env.XC_SEEDS ?? 160);
const SEED_ONLY = process.env.XC_SEED_ONLY
  ? Number(process.env.XC_SEED_ONLY)
  : null;

// ---------------------------------------------------------------------------
// Seeded generator
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOCALES: ReadonlyArray<readonly [string, string]> = [
  ['en-US', 'USD'],
  ['en-GB', 'GBP'],
  ['de-DE', 'EUR'],
  ['fr-FR', 'EUR'],
  ['fr-CH', 'CHF'],
  ['de-CH', 'CHF'],
  ['ja-JP', 'JPY'],
  ['ko-KR', 'KRW'],
  ['zh-CN', 'CNY'],
  ['zh-TW', 'TWD'],
  ['en-IN', 'INR'],
  ['hi-IN', 'INR'],
  ['pt-BR', 'BRL'],
  ['es-MX', 'MXN'],
  ['es-ES', 'EUR'],
  ['it-IT', 'EUR'],
  ['nl-NL', 'EUR'],
  ['sv-SE', 'SEK'],
  ['nb-NO', 'NOK'],
  ['da-DK', 'DKK'],
  ['pl-PL', 'PLN'],
  ['cs-CZ', 'CZK'],
  ['hu-HU', 'HUF'],
  ['tr-TR', 'TRY'],
  ['ru-RU', 'RUB'],
  ['uk-UA', 'UAH'],
  ['ar-SA', 'SAR'],
  ['ar-AE', 'AED'],
  ['ar-EG', 'EGP'],
  ['he-IL', 'ILS'],
  ['th-TH', 'THB'],
  ['vi-VN', 'VND'],
  ['id-ID', 'IDR'],
  ['ms-MY', 'MYR'],
  ['en-AU', 'AUD'],
  ['en-CA', 'CAD'],
  ['fr-CA', 'CAD'],
  ['en-NZ', 'NZD'],
  ['en-SG', 'SGD'],
  ['en-ZA', 'ZAR'],
  ['en-NG', 'NGN'],
  ['fa-IR', 'IRR'],
  ['bn-BD', 'BDT'],
  ['el-GR', 'EUR'],
  ['fi-FI', 'EUR'],
  ['ro-RO', 'RON'],
  ['bg-BG', 'BGN'],
  ['en-PH', 'PHP'],
  ['es-CO', 'COP'],
  ['es-AR', 'ARS'],
  ['es-CL', 'CLP'],
  ['pt-PT', 'EUR'],
  ['sw-KE', 'KES'],
  ['is-IS', 'ISK'],
];

interface Fixture {
  seed: number;
  locale: string;
  currency: string;
  plans: StorePlans;
  present: BillingPeriod[];
}

function currencyFormatter(locale: string, currency: string) {
  return new Intl.NumberFormat(locale, { style: 'currency', currency });
}

function roundTo(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function makePlan(
  period: BillingPeriod,
  price: number,
  fmt: Intl.NumberFormat,
  trial: boolean,
): StorePlan {
  const perMonth =
    period === 'lifetime'
      ? null
      : period === 'annual'
        ? fmt.format(price / 12)
        : fmt.format(price);
  return {
    id: `${period}-plan`,
    productId: `pickle_sensei_pro_${period}`,
    period,
    price,
    priceString: fmt.format(price),
    pricePerMonthString: perMonth,
    freeTrial:
      trial && period !== 'lifetime'
        ? { label: '7-day free trial', periodIso8601: 'P7D' }
        : null,
  };
}

function fixtureFor(seed: number): Fixture {
  const rnd = mulberry32(seed);
  const [locale, currency] = LOCALES[Math.floor(rnd() * LOCALES.length)]!;
  const fmt = currencyFormatter(locale, currency);
  const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
  // Zero-decimal currencies price in the hundreds/thousands; others in units.
  const scale = digits === 0 ? 1000 : 1;
  const monthlyPrice = roundTo((0.49 + rnd() * 29.5) * scale, digits);
  // 0.3..1.3 of 12×monthly: roughly a quarter of seeds make yearly NOT cheaper.
  const annualPrice = roundTo(monthlyPrice * 12 * (0.3 + rnd()), digits);
  const lifetimePrice = roundTo(monthlyPrice * (12 + rnd() * 48), digits);
  const trialOnAnnual = rnd() < 0.35;
  const trialOnMonthly = rnd() < 0.15;

  // Random plan subset; always at least one plan (an empty offering is a
  // store failure handled by normalizePlans, not a paywall render state).
  let present: BillingPeriod[] = (
    ['monthly', 'annual', 'lifetime'] as const
  ).filter(() => rnd() < 0.8);
  if (present.length === 0) {
    present = [
      (['monthly', 'annual', 'lifetime'] as const)[Math.floor(rnd() * 3)]!,
    ];
  }
  // A few seeds hand back a zero monthly price (free intro tier) to prove the
  // savings badge never divides by it.
  const zeroMonthly = rnd() < 0.05;

  const plans: StorePlans = {
    offeringId: 'default',
    monthly: present.includes('monthly')
      ? makePlan('monthly', zeroMonthly ? 0 : monthlyPrice, fmt, trialOnMonthly)
      : null,
    annual: present.includes('annual')
      ? makePlan('annual', annualPrice, fmt, trialOnAnnual)
      : null,
    lifetime: present.includes('lifetime')
      ? makePlan('lifetime', lifetimePrice, fmt, false)
      : null,
  };
  return { seed, locale, currency, plans, present };
}

/** Hand-built adversarial store strings (RTL marks, NBSP, code+symbol, long). */
const HANDCRAFTED: Array<{
  name: string;
  monthly: [number, string, string] | null;
  annual: [number, string, string | null] | null;
  lifetime: [number, string] | null;
}> = [
  {
    name: 'rtl-arabic-marks',
    monthly: [29.99, '‏٢٩٫٩٩ ر.س.‏', '‏٢٩٫٩٩ ر.س.‏'],
    annual: [199.99, '‏١٩٩٫٩٩ ر.س.‏', '‏١٦٫٦٧ ر.س.‏'],
    lifetime: [499.99, '‏٤٩٩٫٩٩ ر.س.‏'],
  },
  {
    name: 'nbsp-and-euro-suffix',
    monthly: [7.99, '7,99\u00a0€', '7,99\u00a0€'],
    annual: [59.99, '59,99\u00a0€', '5,00\u00a0€'],
    lifetime: [159.99, '159,99\u00a0€'],
  },
  {
    name: 'idr-long-string',
    monthly: [129000, 'Rp\u00a0129.000,00', 'Rp\u00a0129.000,00'],
    annual: [999000, 'Rp\u00a0999.000,00', 'Rp\u00a083.250,00'],
    lifetime: [2499000, 'Rp\u00a02.499.000,00'],
  },
  {
    name: 'code-prefixed-dollar',
    monthly: [11.99, 'US$\u00a011.99', 'US$\u00a011.99'],
    annual: [89.99, 'US$\u00a089.99', 'US$\u00a07.50'],
    lifetime: [229.99, 'US$\u00a0229.99'],
  },
  {
    name: 'annual-without-per-month-string',
    monthly: [7.99, '$7.99', '$7.99'],
    annual: [59.99, '$59.99', null],
    lifetime: [159.99, '$159.99'],
  },
  {
    name: 'lifetime-only',
    monthly: null,
    annual: null,
    lifetime: [159.99, 'CHF\u00a0159.99'],
  },
  {
    name: 'monthly-only',
    monthly: [7.99, '£7.99', '£7.99'],
    annual: null,
    lifetime: null,
  },
  {
    name: 'annual-not-cheaper',
    monthly: [4.99, '$4.99', '$4.99'],
    annual: [79.99, '$79.99', '$6.67'],
    lifetime: null,
  },
  {
    name: 'annual-exactly-12x',
    monthly: [5, '5,00\u00a0€', '5,00\u00a0€'],
    annual: [60, '60,00\u00a0€', '5,00\u00a0€'],
    lifetime: null,
  },
  {
    name: 'monthly-zero-price',
    monthly: [0, 'Free', 'Free'],
    annual: [59.99, '$59.99', '$5.00'],
    lifetime: [159.99, '$159.99'],
  },
  {
    name: 'ja-yen-fullwidth',
    monthly: [1200, '￥1,200', '￥1,200'],
    annual: [8800, '￥8,800', '￥733'],
    lifetime: [24000, '￥24,000'],
  },
  {
    name: 'inr-lakh-grouping',
    monthly: [649, '₹649.00', '₹649.00'],
    annual: [4999, '₹4,999.00', '₹416.58'],
    lifetime: [12999, '₹12,999.00'],
  },
];

function handcraftedFixture(index: number): Fixture {
  const h = HANDCRAFTED[index]!;
  const plan = (
    period: BillingPeriod,
    price: number,
    priceString: string,
    perMonth: string | null,
  ): StorePlan => ({
    id: `${period}-plan`,
    productId: `pickle_sensei_pro_${period}`,
    period,
    price,
    priceString,
    pricePerMonthString: period === 'lifetime' ? null : perMonth,
    freeTrial: null,
  });
  const plans: StorePlans = {
    offeringId: 'default',
    monthly: h.monthly ? plan('monthly', ...h.monthly) : null,
    annual: h.annual ? plan('annual', ...h.annual) : null,
    lifetime: h.lifetime
      ? plan('lifetime', h.lifetime[0], h.lifetime[1], null)
      : null,
  };
  const present = (['monthly', 'annual', 'lifetime'] as const).filter(
    p => plans[p] !== null,
  );
  return {
    seed: -(index + 1),
    locale: `handcrafted:${h.name}`,
    currency: '-',
    plans,
    present,
  };
}

// ---------------------------------------------------------------------------
// Oracle (independent of PaywallScreen's implementation)
// ---------------------------------------------------------------------------

const TITLES: Record<BillingPeriod, string> = {
  monthly: 'Monthly',
  annual: 'Yearly',
  lifetime: 'Lifetime',
};
const PERIOD_WORD: Record<BillingPeriod, string> = {
  monthly: 'per month',
  annual: 'per year',
  lifetime: 'one-time',
};
const CTA_SUFFIX: Record<BillingPeriod, string> = {
  monthly: '/mo',
  annual: '/yr',
  lifetime: ' once',
};

function expectedSavings(plans: StorePlans): string | null {
  const { annual, monthly } = plans;
  if (!annual || !monthly || monthly.price <= 0) return null;
  const yearAtMonthly = monthly.price * 12;
  if (annual.price >= yearAtMonthly) return null;
  const pct = Math.round(
    ((yearAtMonthly - annual.price) / yearAtMonthly) * 100,
  );
  return pct > 0 ? `SAVE ${pct}%` : null;
}

function expectedDefaultSelection(plans: StorePlans): BillingPeriod {
  return plans.annual
    ? 'annual'
    : plans.lifetime
      ? 'lifetime'
      : plans.monthly
        ? 'monthly'
        : 'annual';
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

const freeAccess: CanonicalAccessState = {
  premium: false,
  entitlements: [],
  freeRatings: {
    limit: 2,
    used: 1,
    reserved: 0,
    remaining: 1,
    availableToReserve: 1,
  },
  canStartRating: true,
  paywallRequired: false,
};

function dependencies(
  loadPlans: () => Promise<StorePlans>,
): BillingAccessDependencies {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(loadPlans),
      purchase: jest.fn(async () => ({
        premium: true,
        productId: 'x',
        expirationDate: null,
      })),
      restore: jest.fn(async () => ({
        premium: true,
        productId: 'x',
        expirationDate: null,
      })),
      readEntitlement: jest.fn(async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      })),
    },
    backend: {
      getAccess: jest.fn(async () => freeAccess),
      syncBilling: jest.fn(async () => {
        throw new Error('not exercised');
      }),
    },
  };
}

async function flush() {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
  });
}

async function renderPricingPage() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PaywallScreen
        onClose={jest.fn()}
        onOpenTerms={jest.fn()}
        onOpenPrivacy={jest.fn()}
      />,
    );
  });
  await flush();
  await act(async () => {
    press(byTestId(renderer, 'paywall-see-plans'));
  });
  await flush();
  return renderer;
}

/**
 * Host-level pressable (the native View an RN <Pressable> renders). Its
 * `onClick` is the accessibility-activate path VoiceOver double-tap uses and
 * honours `disabled`, so every press in this harness goes through it.
 */
function maybeByTestId(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  return renderer.root.findAll(
    n =>
      typeof n.type === 'string' &&
      n.props.testID === testID &&
      typeof n.props.onClick === 'function',
  );
}

function byTestId(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  const nodes = maybeByTestId(renderer, testID);
  if (nodes.length !== 1) {
    throw new Error(
      `Expected exactly one host pressable with testID ${testID}, got ${nodes.length}`,
    );
  }
  return nodes[0]!;
}

function press(node: TestRenderer.ReactTestInstance) {
  node.props.onClick();
}

function textWithin(node: TestRenderer.ReactTestInstance): string {
  return node
    .findAllByType(Text)
    .map(n => n.props.children)
    .flat(Infinity)
    .filter(
      (c): c is string | number =>
        typeof c === 'string' || typeof c === 'number',
    )
    .map(String)
    .join(' ');
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return textWithin(renderer.root);
}

/** Text that remains after removing every store-supplied string. */
function residualText(text: string, fixture: Fixture, savings: string | null) {
  let out = text;
  for (const period of fixture.present) {
    const plan = fixture.plans[period]!;
    out = out.split(plan.priceString).join(' ');
    if (plan.pricePerMonthString) {
      out = out.split(plan.pricePerMonthString).join(' ');
    }
    if (plan.freeTrial) out = out.split(plan.freeTrial.label).join(' ');
  }
  if (savings) out = out.split(savings).join(' ');
  return out;
}

const CURRENCY_SYMBOL = /\p{Sc}/u;
const PRICE_LIKE = /\d[\d.,\u00a0 ]*[.,]\d{2}\b/;

interface SeedRecord {
  seed: number;
  locale: string;
  currency: string;
  present: BillingPeriod[];
  priceStrings: Record<string, string>;
  perMonth: Record<string, string | null>;
  savings: string | null;
  defaultSelected: BillingPeriod;
  longestPriceString: number;
  checks: number;
  failures: string[];
}

const table: SeedRecord[] = [];

function replayHint(fixture: Fixture): string {
  return `seed=${fixture.seed} replay: XC_SEED_ONLY=${fixture.seed} npx jest __tests__/xc/screen-ux-a11y-i18n-4/paywallLocaleFuzz.test.tsx\nfixture=${JSON.stringify(
    fixture.plans,
  )}`;
}

async function auditFixture(fixture: Fixture): Promise<SeedRecord> {
  const failures: string[] = [];
  let checks = 0;
  const check = (cond: boolean, what: string) => {
    checks += 1;
    if (!cond) failures.push(what);
  };

  clearAccessStoreConfiguration();
  configureAccessStore(dependencies(async () => fixture.plans));
  const renderer = await renderPricingPage();
  const savings = expectedSavings(fixture.plans);
  const defaultSelected = expectedDefaultSelection(fixture.plans);

  try {
    check(
      useAccessStore.getState().selectedPeriod === defaultSelected,
      `default selection ${useAccessStore.getState().selectedPeriod} != ${defaultSelected}`,
    );

    for (const period of ['monthly', 'annual', 'lifetime'] as const) {
      const plan = fixture.plans[period];
      const columns = maybeByTestId(renderer, `paywall-plan-${period}`);
      if (!plan) {
        check(
          columns.length === 0,
          `${period}: column rendered for missing plan`,
        );
        continue;
      }
      check(
        columns.length === 1,
        `${period}: expected 1 column, got ${columns.length}`,
      );
      const column = columns[0];
      if (!column) continue;
      const text = textWithin(column);
      const label = String(column.props.accessibilityLabel ?? '');
      check(
        text.includes(plan.priceString),
        `${period}: column text lacks priceString "${plan.priceString}" (got "${text}")`,
      );
      check(
        label.includes(plan.priceString),
        `${period}: a11y label lacks priceString (got "${label}")`,
      );
      check(
        label.startsWith(`${TITLES[period]} membership`),
        `${period}: a11y label does not start with title (got "${label}")`,
      );
      check(
        label.includes(PERIOD_WORD[period]),
        `${period}: a11y label lacks cadence "${PERIOD_WORD[period]}" (got "${label}")`,
      );
      const isDefault = period === defaultSelected;
      check(
        Boolean(column.props.accessibilityState?.selected) === isDefault,
        `${period}: selected state ${column.props.accessibilityState?.selected} != ${isDefault}`,
      );
      check(
        label.endsWith(', selected') === isDefault,
        `${period}: label selected suffix mismatch (got "${label}")`,
      );
      // No other plan's price leaks into this column.
      for (const other of fixture.present) {
        if (other === period) continue;
        const otherPrice = fixture.plans[other]!.priceString;
        // Legitimate coincidences: own price contains the other as a
        // substring ("159,99 €" ⊃ "59,99 €"), or the store's monthly
        // equivalent happens to equal the monthly price.
        if (plan.priceString.includes(otherPrice)) continue;
        if (plan.pricePerMonthString === otherPrice) continue;
        check(
          !text.includes(otherPrice),
          `${period}: column shows ${other} price "${otherPrice}"`,
        );
      }
      if (period === 'annual') {
        if (plan.pricePerMonthString) {
          check(
            text.includes(`${plan.pricePerMonthString}/mo`),
            `annual: qualifier lacks store pricePerMonthString "${plan.pricePerMonthString}" (got "${text}")`,
          );
        } else {
          check(
            text.includes('/year · billed yearly'),
            `annual: no per-month string fallback wording (got "${text}")`,
          );
        }
        check(
          text.includes('billed yearly'),
          'annual: missing "billed yearly"',
        );
        if (savings) {
          check(
            text.includes(savings),
            `annual: expected badge "${savings}" (got "${text}")`,
          );
        } else {
          check(
            !/SAVE \d+%/.test(text),
            `annual: unexpected SAVE badge (got "${text}")`,
          );
        }
      }
      if (period === 'lifetime') {
        check(
          text.includes('one-time'),
          `lifetime: missing one-time wording (got "${text}")`,
        );
        check(
          !/\/mo\b/.test(text),
          `lifetime: shows a per-month figure (got "${text}")`,
        );
      }
      if (period === 'monthly') {
        check(
          text.includes('billed monthly'),
          `monthly: missing "billed monthly" (got "${text}")`,
        );
      }
    }

    // Whole-page residual: nothing price-like the store did not send.
    const pageText = allText(renderer);
    const residual = residualText(pageText, fixture, savings);
    check(
      !CURRENCY_SYMBOL.test(residual),
      `page renders a currency symbol not supplied by the store: "${residual.match(CURRENCY_SYMBOL)?.[0]}" in "${residual}"`,
    );
    check(
      !PRICE_LIKE.test(residual),
      `page renders a price-like number not supplied by the store: "${residual.match(PRICE_LIKE)?.[0]}"`,
    );

    // Select each present plan; CTA + legal restatement must follow.
    for (const period of fixture.present) {
      const plan = fixture.plans[period]!;
      await act(async () => {
        press(byTestId(renderer, `paywall-plan-${period}`));
      });
      const cta = byTestId(renderer, 'paywall-continue');
      const ctaLabel = String(cta.props.accessibilityLabel ?? '');
      const expectedCta = plan.freeTrial
        ? 'Start free trial'
        : `Continue · ${plan.priceString}${CTA_SUFFIX[period]}`;
      check(
        ctaLabel === expectedCta,
        `${period}: CTA label "${ctaLabel}" != "${expectedCta}"`,
      );
      check(
        textWithin(cta).includes(expectedCta),
        `${period}: CTA visible text lacks "${expectedCta}"`,
      );
      const legal = allText(renderer);
      check(
        legal.includes(plan.priceString),
        `${period}: legal restatement lacks priceString after selection`,
      );
      if (period === 'lifetime') {
        check(
          legal.includes(
            `${plan.priceString} one-time purchase. Not a subscription — no renewal.`,
          ),
          'lifetime: legal restatement wording',
        );
      } else {
        check(
          legal.includes(
            `${plan.priceString} per ${PERIOD_WORD[period].replace('per ', '')}, automatically renewing until canceled.`,
          ),
          `${period}: legal renewal wording`,
        );
        if (plan.freeTrial) {
          check(
            legal.includes(
              `After the ${plan.freeTrial.label}, ${plan.priceString}`,
            ),
            `${period}: trial legal wording`,
          );
        }
      }
      const column = byTestId(renderer, `paywall-plan-${period}`);
      check(
        column.props.accessibilityState?.selected === true,
        `${period}: not marked selected after press`,
      );
      for (const other of fixture.present) {
        if (other === period) continue;
        const otherCol = byTestId(renderer, `paywall-plan-${other}`);
        check(
          otherCol.props.accessibilityState?.selected !== true,
          `${other}: still selected after selecting ${period}`,
        );
      }
    }

    // Legal / restore controls stay reachable and labelled on every fixture.
    check(
      byTestId(renderer, 'paywall-restore').props.accessibilityLabel ===
        'Restore purchases',
      'restore label',
    );
    check(
      renderer.root.findAll(
        n =>
          n.props.accessibilityLabel === 'Terms of use' &&
          n.props.accessibilityRole === 'link',
      ).length > 0,
      'terms link',
    );
    check(
      renderer.root.findAll(
        n =>
          n.props.accessibilityLabel === 'Privacy policy' &&
          n.props.accessibilityRole === 'link',
      ).length > 0,
      'privacy link',
    );
  } finally {
    act(() => renderer.unmount());
  }

  const priceStrings: Record<string, string> = {};
  const perMonth: Record<string, string | null> = {};
  for (const period of fixture.present) {
    priceStrings[period] = fixture.plans[period]!.priceString;
    perMonth[period] = fixture.plans[period]!.pricePerMonthString;
  }
  return {
    seed: fixture.seed,
    locale: fixture.locale,
    currency: fixture.currency,
    present: fixture.present,
    priceStrings,
    perMonth,
    savings,
    defaultSelected,
    longestPriceString: Math.max(
      ...fixture.present.map(p => fixture.plans[p]!.priceString.length),
    ),
    checks,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterAll(() => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    seeds: table.length,
    checks: table.reduce((n, r) => n + r.checks, 0),
    failures: table.filter(r => r.failures.length > 0).map(r => r.seed),
    locales: [...new Set(table.map(r => r.locale))].length,
    rows: table,
  };
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, 'paywall-locale-fuzz.json'),
    JSON.stringify(summary, null, 2),
  );
});

describe('PaywallScreen price/locale fuzz (seeded)', () => {
  const seeds =
    SEED_ONLY !== null
      ? [SEED_ONLY]
      : Array.from({ length: SEED_COUNT }, (_, i) => 1000 + i);

  it.each(seeds)(
    'seed %i: store strings pass through untouched',
    async seed => {
      const fixture =
        seed < 0 ? handcraftedFixture(-seed - 1) : fixtureFor(seed);
      const record = await auditFixture(fixture);
      table.push(record);
      if (record.failures.length > 0) {
        throw new Error(
          `${record.failures.join('\n')}\n${replayHint(fixture)}`,
        );
      }
    },
  );

  it.each(HANDCRAFTED.map((h, i) => [h.name, i] as const))(
    'handcrafted %s: store strings pass through untouched',
    async (_name, index) => {
      if (SEED_ONLY !== null && SEED_ONLY !== -(index + 1)) return;
      const fixture = handcraftedFixture(index);
      const record = await auditFixture(fixture);
      table.push(record);
      if (record.failures.length > 0) {
        throw new Error(
          `${record.failures.join('\n')}\n${replayHint(fixture)}`,
        );
      }
    },
  );

  it('store failure: honest unavailable state, retry reachable, no invented price', async () => {
    clearAccessStoreConfiguration();
    configureAccessStore(
      dependencies(async () => {
        throw new Error('offerings unavailable');
      }),
    );
    const renderer = await renderPricingPage();
    try {
      const text = allText(renderer);
      expect(text).toContain('Store pricing unavailable');
      expect(CURRENCY_SYMBOL.test(text)).toBe(false);
      expect(PRICE_LIKE.test(text)).toBe(false);
      expect(maybeByTestId(renderer, 'paywall-plan-monthly')).toHaveLength(0);
      expect(maybeByTestId(renderer, 'paywall-plan-annual')).toHaveLength(0);
      expect(maybeByTestId(renderer, 'paywall-plan-lifetime')).toHaveLength(0);
      expect(byTestId(renderer, 'paywall-retry').props.accessibilityLabel).toBe(
        'Retry loading membership',
      );
      const cta = byTestId(renderer, 'paywall-continue');
      expect(cta.props.accessibilityLabel).toBe('Store pricing unavailable');
      expect(cta.props.accessibilityState?.disabled).toBe(true);
      table.push({
        seed: 0,
        locale: 'store-failure',
        currency: '-',
        present: [],
        priceStrings: {},
        perMonth: {},
        savings: null,
        defaultSelected: 'annual',
        longestPriceString: 0,
        checks: 8,
        failures: [],
      });
    } finally {
      act(() => renderer.unmount());
    }
  });
});
