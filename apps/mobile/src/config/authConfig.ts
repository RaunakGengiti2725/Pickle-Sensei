import { getRuntimePublicConfig } from './runtimeConfig';

/**
 * Compatibility exports for the auth UI. Values live with the rest of the
 * checked-in public runtime configuration so release configuration has one
 * explicit source of truth.
 */
export const GOOGLE_IOS_CLIENT_ID = getRuntimePublicConfig().googleIosClientId;
export const GOOGLE_WEB_CLIENT_ID = getRuntimePublicConfig().googleWebClientId;
