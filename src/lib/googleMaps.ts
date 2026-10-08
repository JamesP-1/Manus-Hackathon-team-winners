export type GoogleMapsLoadErrorCode =
  | 'authentication'
  | 'configuration'
  | 'network'
  | 'timeout'
  | 'unavailable';

/**
 * Deliberately generic errors: Maps script URLs can contain browser-visible keys,
 * so callers should never render an underlying network error verbatim.
 */
export class GoogleMapsLoadError extends Error {
  constructor(
    public readonly code: GoogleMapsLoadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GoogleMapsLoadError';
  }
}

export interface GoogleMapsSdk {
  maps: {
    importLibrary: (libraryName: string) => Promise<unknown>;
  };
}

interface GoogleMapsWindow extends Window {
  google?: GoogleMapsSdk;
  gm_authFailure?: () => void;
}

const SDK_LOAD_TIMEOUT_MS = 15_000;
const LIBRARY_LOAD_TIMEOUT_MS = 12_000;
const SCRIPT_SELECTOR = 'script[data-dcu-google-maps-sdk="true"]';

let sdkLoadPromise: Promise<GoogleMapsSdk> | null = null;

function getGoogleMapsSdk(): GoogleMapsSdk | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const candidate = (window as GoogleMapsWindow).google;
  return candidate && typeof candidate.maps?.importLibrary === 'function'
    ? candidate
    : null;
}

function buildMapsScriptUrl(): string {
  const directKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY?.trim();
  const parameters = new URLSearchParams({
    v: 'beta',
    libraries: 'maps3d',
    loading: 'async',
  });

  if (directKey) {
    parameters.set('key', directKey);
    return `https://maps.googleapis.com/maps/api/js?${parameters.toString()}`;
  }

  const manusApiUrl = import.meta.env.VITE_MANUS_API_URL?.trim();
  const browserKey = import.meta.env.VITE_MANUS_API_BROWSER_KEY?.trim();
  if (!manusApiUrl || !browserKey) {
    throw new GoogleMapsLoadError(
      'configuration',
      'Google Maps needs either VITE_GOOGLE_MAPS_API_KEY or the managed Manus browser configuration.',
    );
  }

  // The managed endpoint is intentionally used only when no user-supplied key is present.
  const managedBaseUrl = manusApiUrl.replace(/\/+$/, '');
  parameters.set('key', browserKey);
  return `${managedBaseUrl}/v1/maps/proxy/maps/api/js?${parameters.toString()}`;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  error: GoogleMapsLoadError,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(error), timeoutMs);
    void promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (reason: unknown) => {
        window.clearTimeout(timeout);
        reject(reason);
      },
    );
  });
}

function createSdkLoadPromise(): Promise<GoogleMapsSdk> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(
      new GoogleMapsLoadError(
        'unavailable',
        'Google Maps can only load in a browser.',
      ),
    );
  }

  const loadedSdk = getGoogleMapsSdk();
  if (loadedSdk) {
    return Promise.resolve(loadedSdk);
  }

  let scriptUrl: string;
  try {
    scriptUrl = buildMapsScriptUrl();
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise<GoogleMapsSdk>((resolve, reject) => {
    const mapsWindow = window as GoogleMapsWindow;
    const existingScript = document.querySelector<HTMLScriptElement>(SCRIPT_SELECTOR);
    const script = existingScript ?? document.createElement('script');
    const previousAuthFailure = mapsWindow.gm_authFailure;
    let settled = false;

    const restoreAuthHandler = () => {
      if (mapsWindow.gm_authFailure !== onAuthenticationFailure) {
        return;
      }

      if (previousAuthFailure) {
        mapsWindow.gm_authFailure = previousAuthFailure;
      } else {
        delete mapsWindow.gm_authFailure;
      }
    };

    const cleanup = () => {
      window.clearTimeout(timeout);
      script.removeEventListener('load', onLoad);
      script.removeEventListener('error', onNetworkError);
      restoreAuthHandler();
    };

    const succeed = (sdk: GoogleMapsSdk) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(sdk);
    };

    const fail = (error: GoogleMapsLoadError) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const onLoad = () => {
      const sdk = getGoogleMapsSdk();
      if (sdk) {
        succeed(sdk);
      } else {
        fail(
          new GoogleMapsLoadError(
            'unavailable',
            'The Google Maps JavaScript API loaded without its importLibrary interface.',
          ),
        );
      }
    };

    const onNetworkError = () => {
      fail(
        new GoogleMapsLoadError(
          'network',
          'The Google Maps JavaScript API request could not be completed.',
        ),
      );
    };

    const onAuthenticationFailure = () => {
      try {
        previousAuthFailure?.();
      } finally {
        fail(
          new GoogleMapsLoadError(
            'authentication',
            'Google Maps rejected the current browser configuration.',
          ),
        );
      }
    };

    const timeout = window.setTimeout(() => {
      fail(
        new GoogleMapsLoadError(
          'timeout',
          'Timed out while loading the Google Maps JavaScript API.',
        ),
      );
    }, SDK_LOAD_TIMEOUT_MS);

    mapsWindow.gm_authFailure = onAuthenticationFailure;
    script.addEventListener('load', onLoad, { once: true });
    script.addEventListener('error', onNetworkError, { once: true });

    if (!existingScript) {
      script.dataset.dcuGoogleMapsSdk = 'true';
      script.async = true;
      script.src = scriptUrl;
      document.head.append(script);
    }
  });
}

/**
 * Loads the Maps JavaScript SDK exactly once for this module lifetime. The script
 * request uses the supplied direct browser key when present, otherwise Manus's
 * documented browser-key proxy endpoint.
 */
export function loadGoogleMaps(): Promise<GoogleMapsSdk> {
  sdkLoadPromise ??= createSdkLoadPromise();
  return sdkLoadPromise;
}

/**
 * Imports an SDK library with a bounded wait after the shared SDK script has loaded.
 */
export async function loadGoogleMapsLibrary<T = unknown>(
  libraryName: string,
): Promise<T> {
  const sdk = await loadGoogleMaps();

  try {
    return await withTimeout(
      Promise.resolve(sdk.maps.importLibrary(libraryName)) as Promise<T>,
      LIBRARY_LOAD_TIMEOUT_MS,
      new GoogleMapsLoadError(
        'timeout',
        `Timed out while loading the Google Maps ${libraryName} library.`,
      ),
    );
  } catch (error) {
    if (error instanceof GoogleMapsLoadError) {
      throw error;
    }

    throw new GoogleMapsLoadError(
      'unavailable',
      `The Google Maps ${libraryName} library could not be loaded.`,
    );
  }
}
