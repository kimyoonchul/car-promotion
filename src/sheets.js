import { google } from 'googleapis';

export const SHEET_HEADER = ['수집일', '딜러사', '분류', '캠페인명', '게시일', '기간', '혜택', '정비캠페인', '링크'];

export async function appendRows(rows) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const credsJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!spreadsheetId || !credsJson || rows.length === 0) return false;

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(credsJson),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: 'A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });
  return true;
}
