# getIPTV Mobile

Separate Expo Go preview app for iOS and Android. The Windows Electron app remains in `outputs/luma-tv`.

## Preview on an iPhone from Windows

1. Install **Expo Go** from the iPhone App Store and sign in to an Expo account.
2. Open this `getiptv-mobile` folder in VS Code.
3. Open the VS Code terminal in this folder and run `npx expo start`.
4. Sign in to the same Expo account if prompted. Scan the QR code with the iPhone Camera or Expo Go.
5. Keep the development server running while previewing. Saving a code change refreshes the preview.

The computer and phone should use the same Wi-Fi. If the network blocks local connections, run `npx expo start --tunnel` instead.

## Current mobile preview

- getIPTV home screen with Live, Movies, Shows, and Radio sections
- add an M3U playlist by URL and save that URL on the phone
- category and group filtering, plus channel search
- native video playback using the platform player

This is the first mobile foundation, not full Windows feature parity yet. The current preview loads one playlist URL at a time. A Mac with Xcode is still required for the iOS Simulator; Expo Go on a real iPhone works from Windows.
