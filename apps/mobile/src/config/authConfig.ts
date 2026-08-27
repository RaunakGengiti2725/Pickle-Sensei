/**
 * OAuth client configuration.
 *
 * GOOGLE_IOS_CLIENT_ID: create an iOS OAuth client in Google Cloud Console
 * (APIs & Services → Credentials → OAuth client ID → iOS, bundle id
 * org.reactjs.native.example.PickleSensei until rebranded), paste the client
 * id here, and add the reversed client id as a URL scheme in Info.plist.
 * While null, Google sign-in shows an explicit "not configured" state —
 * it is never faked.
 */
export const GOOGLE_IOS_CLIENT_ID: string | null = null;
