/** Real Google Sheets integration: sign in with a Google account (OAuth, client-side only —
 *  no server/backend), then read a specific row's columns or append a new row for an
 *  annotation. Uses Google Identity Services (GIS) for the token flow and the Sheets API
 *  v4 REST endpoints directly via fetch. Lab-only tooling; credentials (Client ID, sheet
 *  ID, tab name) are user-supplied and kept in localStorage — never hardcoded, since they're
 *  specific to each user's own Google Cloud project and spreadsheet. */

export interface SheetsConfig {
    clientId: string;
    spreadsheetId: string;
    tabName: string;
}

const STORAGE_KEY = "babylon-lite-sheets-config";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

let gisLoadPromise: Promise<void> | null = null;
let tokenClient: GisTokenClient | null = null;
let accessToken: string | null = null;

/** Lazily inject the Google Identity Services script (only one <script> tag, shared across reloads of this module). */
function loadGis(): Promise<void> {
    if (gisLoadPromise) {
        return gisLoadPromise;
    }
    gisLoadPromise = new Promise((resolve, reject) => {
        if (window.google?.accounts?.oauth2) {
            resolve();
            return;
        }
        const script = document.createElement("script");
        script.src = "https://accounts.google.com/gsi/client";
        script.async = true;
        script.defer = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Failed to load Google Identity Services script"));
        document.head.appendChild(script);
    });
    return gisLoadPromise;
}

export function loadSheetsConfig(): SheetsConfig {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            return {
                clientId: typeof parsed.clientId === "string" ? parsed.clientId : "",
                spreadsheetId: typeof parsed.spreadsheetId === "string" ? parsed.spreadsheetId : "",
                tabName: typeof parsed.tabName === "string" ? parsed.tabName : "",
            };
        }
    } catch {
        // Ignore malformed/unavailable storage; fall through to defaults.
    }
    return { clientId: "", spreadsheetId: "", tabName: "" };
}

export function saveSheetsConfig(config: SheetsConfig): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function isConnected(): boolean {
    return accessToken !== null;
}

/** Trigger the Google OAuth sign-in popup. Must be called from a user gesture (e.g. a button click). */
export function connect(clientId: string): Promise<void> {
    return loadGis().then(
        () =>
            new Promise<void>((resolve, reject) => {
                tokenClient =
                    tokenClient ??
                    window.google!.accounts.oauth2.initTokenClient({
                        client_id: clientId,
                        scope: SCOPE,
                        callback: (response) => {
                            if (response.error) {
                                reject(new Error(response.error));
                                return;
                            }
                            accessToken = response.access_token;
                            resolve();
                        },
                    });
                tokenClient.requestAccessToken({ prompt: accessToken ? "" : "consent" });
            })
    );
}

function columnLetter(index: number): string {
    let n = index + 1;
    let letters = "";
    while (n > 0) {
        const rem = (n - 1) % 26;
        letters = String.fromCharCode(65 + rem) + letters;
        n = Math.floor((n - 1) / 26);
    }
    return letters;
}

async function sheetsFetch(url: string, init?: RequestInit): Promise<any> {
    if (!accessToken) {
        throw new Error("Not connected to Google Sheets. Click Connect first.");
    }
    const resp = await fetch(url, {
        ...init,
        headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`Sheets API error ${resp.status}: ${body || resp.statusText}`);
    }
    return resp.json();
}

/** Read the header row (row 1) plus one data row, zipped into { header: value } pairs. */
export async function readRow(config: SheetsConfig, rowNumber: number): Promise<Record<string, string> | null> {
    if (rowNumber < 2) {
        throw new Error("Row number must be 2 or greater (row 1 is the header).");
    }
    const range = encodeURIComponent(`${config.tabName}!A1:Z${rowNumber}`);
    const data = await sheetsFetch(`https://sheets.googleapis.com/v4/spreadsheets/${config.spreadsheetId}/values/${range}`);
    const rows: string[][] = data.values ?? [];
    const headers = rows[0] ?? [];
    const target = rows[rowNumber - 1];
    if (!target) {
        return null;
    }
    const result: Record<string, string> = {};
    headers.forEach((header, i) => {
        if (header) {
            result[header] = target[i] ?? "";
        }
    });
    return result;
}

/** Append a new row built from the annotation, matching columns by header name (case-insensitive
 *  substring match against "note"/"description", "color", "x"/"y"/"z", "id"). Unmatched columns
 *  are left blank. Returns the 1-based row number the data landed in. */
export async function appendAnnotationRow(
    config: SheetsConfig,
    annotation: { id: string; note: string; color: string; position: readonly [number, number, number] }
): Promise<number> {
    const headerRange = encodeURIComponent(`${config.tabName}!A1:Z1`);
    const headerData = await sheetsFetch(`https://sheets.googleapis.com/v4/spreadsheets/${config.spreadsheetId}/values/${headerRange}`);
    const headers: string[] = headerData.values?.[0] ?? [];

    const row = headers.map((headerRaw) => {
        const header = headerRaw.toLowerCase();
        if (header.includes("note") || header.includes("description")) {
            return annotation.note;
        }
        if (header.includes("color")) {
            return annotation.color;
        }
        if (header === "x" || header.includes(" x") || header.endsWith("x")) {
            return annotation.position[0];
        }
        if (header === "y" || header.includes(" y") || header.endsWith("y")) {
            return annotation.position[1];
        }
        if (header === "z" || header.includes(" z") || header.endsWith("z")) {
            return annotation.position[2];
        }
        if (header.includes("id")) {
            return annotation.id;
        }
        return "";
    });

    const range = encodeURIComponent(`${config.tabName}!A1`);
    const result = await sheetsFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${config.spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ values: [row] }),
        }
    );

    // updatedRange looks like "EveryPoint!A5:G5" — extract the row number from it.
    const updatedRange: string = result.updates?.updatedRange ?? "";
    const match = /![A-Z]+(\d+)/.exec(updatedRange);
    if (!match) {
        throw new Error("Could not determine the row number the sheet assigned.");
    }
    return Number(match[1]);
}

// columnLetter is kept for potential future targeted-cell writes; referenced here to avoid an unused-export lint flag.
void columnLetter;

interface GisTokenResponse {
    access_token: string;
    error?: string;
}

interface GisTokenClient {
    requestAccessToken(options?: { prompt?: string }): void;
}

declare global {
    interface Window {
        google?: {
            accounts: {
                oauth2: {
                    initTokenClient(config: { client_id: string; scope: string; callback: (response: GisTokenResponse) => void }): GisTokenClient;
                };
            };
        };
    }
}
