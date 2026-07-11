import { google } from 'googleapis';

const SUMMARY_TAB = '지금 진행중';
const LOG_TAB = '전체 로그';

export const SUMMARY_HEADER = ['딜러사', '지역', '캠페인명', '기간', '핵심 혜택', '정비캠페인', '게시일', '링크'];
export const LOG_HEADER = ['수집일', '딜러사', '분류', '캠페인명', '게시일', '기간', '혜택', '정비캠페인', '링크'];

let clientPromise = null;

function getClient() {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const credsJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!spreadsheetId || !credsJson) return null;
  clientPromise ??= (async () => {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(credsJson),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    return { sheets: google.sheets({ version: 'v4', auth }), spreadsheetId };
  })();
  return clientPromise;
}

// 탭이 없으면 만들고, 두 탭의 sheetId(숫자)를 반환한다.
async function ensureTabs(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const byTitle = new Map(meta.data.sheets.map((s) => [s.properties.title, s.properties.sheetId]));

  const toAdd = [SUMMARY_TAB, LOG_TAB].filter((t) => !byTitle.has(t));
  if (toAdd.length) {
    const res = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: toAdd.map((title) => ({ addSheet: { properties: { title } } })) },
    });
    for (const r of res.data.replies) {
      const p = r.addSheet.properties;
      byTitle.set(p.title, p.sheetId);
    }
  }
  return { summaryId: byTitle.get(SUMMARY_TAB), logId: byTitle.get(LOG_TAB) };
}

function headerFormatRequest(sheetId, columnCount) {
  return [
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: columnCount },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.92, green: 0.94, blue: 0.98 } } },
        fields: 'userEnteredFormat(textFormat,backgroundColor)',
      },
    },
    { autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: columnCount } } },
  ];
}

// "지금 진행중" 탭 — 딜러당 1행, 매 실행마다 통째로 덮어쓴다.
export async function writeSummary(rows) {
  const client = getClient();
  if (!client) return false;
  const { sheets, spreadsheetId } = await client;
  const { summaryId } = await ensureTabs(sheets, spreadsheetId);

  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${SUMMARY_TAB}!A:Z` });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SUMMARY_TAB}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [SUMMARY_HEADER, ...rows] },
  });
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: headerFormatRequest(summaryId, SUMMARY_HEADER.length) },
  });
  return true;
}

// "전체 로그" 탭 — 신규 캠페인을 계속 쌓는다 (헤더는 탭이 비어있을 때만 자동으로 추가).
export async function appendLog(rows) {
  const client = getClient();
  if (!client || rows.length === 0) return false;
  const { sheets, spreadsheetId } = await client;
  const { logId } = await ensureTabs(sheets, spreadsheetId);

  const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${LOG_TAB}!A1:A1` });
  const isEmpty = !existing.data.values?.length;

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${LOG_TAB}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: isEmpty ? [LOG_HEADER, ...rows] : rows },
  });
  if (isEmpty) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: headerFormatRequest(logId, LOG_HEADER.length) },
    });
  }
  return true;
}
