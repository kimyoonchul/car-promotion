import { google } from 'googleapis';

const SUMMARY_TAB = '지금 진행중';
const DETAIL_TAB = '상세 혜택';
const LOG_TAB = '전체 로그';

// 요약 탭 — 한눈에 훑는 용도. 핵심 혜택 2~4개만 초압축으로 담는다.
export const SUMMARY_HEADER = ['추천', '딜러사', '지역', '캠페인', '기간 · 마감', '핵심 혜택', '링크'];
const SUMMARY_WIDTHS = [80, 100, 130, 190, 150, 300, 80];

// 상세 탭 — 현재 캠페인의 전체 혜택 목록 (자세히 볼 때만)
export const DETAIL_HEADER = ['딜러사', '캠페인명', '기간', '할인 혜택 (전체)', '무료·사은품 (전체)', '추천 이유', '링크'];
const DETAIL_WIDTHS = [100, 210, 165, 320, 300, 190, 80];

export const LOG_HEADER = ['수집일', '딜러사', '분류', '캠페인명', '게시일', '기간', '할인', '무료·사은품', '정비', '링크'];
const LOG_WIDTHS = [140, 100, 120, 220, 90, 165, 280, 240, 45, 90];

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

// 탭이 없으면 만들고, 탭별 sheetId(숫자)를 반환한다.
async function ensureTabs(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const byTitle = new Map(meta.data.sheets.map((s) => [s.properties.title, s.properties.sheetId]));

  const toAdd = [SUMMARY_TAB, DETAIL_TAB, LOG_TAB].filter((t) => !byTitle.has(t));
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
  return { summaryId: byTitle.get(SUMMARY_TAB), detailId: byTitle.get(DETAIL_TAB), logId: byTitle.get(LOG_TAB) };
}

// 탭 하나를 통째로 덮어쓰고 서식을 다시 적용한다 (요약·상세 탭 공용)
// dimRows: 종료된 캠페인 행의 0-based 데이터 인덱스 — 회색 음영 + 취소선 처리
async function overwriteTab({ sheets, spreadsheetId, tab, sheetId, header, widths, rows, dimRows = [] }) {
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${tab}!A:Z` });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tab}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [header, ...rows] },
  });
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [...formatRequests(sheetId, widths), ...dimRequests(sheetId, widths, dimRows)] },
  });
}

// 종료된 캠페인 행 음영처리 — formatRequests가 서식을 초기화한 뒤에 덮어써야 한다
function dimRequests(sheetId, widths, dimRows) {
  return dimRows.map((i) => ({
    repeatCell: {
      range: { sheetId, startRowIndex: i + 1, endRowIndex: i + 2, startColumnIndex: 0, endColumnIndex: widths.length },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 },
          textFormat: { strikethrough: true, foregroundColor: { red: 0.45, green: 0.45, blue: 0.45 } },
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat)',
    },
  }));
}

// 헤더 강조·틀고정·열너비·줄바꿈 — 매 실행 반복해도 안전한(idempotent) 요청들
function formatRequests(sheetId, widths) {
  return [
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: widths.length },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
            backgroundColor: { red: 0.11, green: 0.41, blue: 0.83 }, // BMW 블루
            verticalAlignment: 'MIDDLE',
          },
        },
        fields: 'userEnteredFormat(textFormat,backgroundColor,verticalAlignment)',
      },
    },
    {
      // 값은 덮어써도 서식은 남으므로, 지난 실행의 음영·취소선을 여기서 초기화한다
      repeatCell: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: widths.length },
        cell: {
          userEnteredFormat: {
            wrapStrategy: 'WRAP',
            verticalAlignment: 'TOP',
            backgroundColor: { red: 1, green: 1, blue: 1 },
            textFormat: { strikethrough: false, foregroundColor: { red: 0, green: 0, blue: 0 } },
          },
        },
        fields: 'userEnteredFormat(wrapStrategy,verticalAlignment,backgroundColor,textFormat)',
      },
    },
    ...widths.map((pixelSize, i) => ({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize },
        fields: 'pixelSize',
      },
    })),
  ];
}

// "지금 진행중"(요약) + "상세 혜택" 탭 — 딜러당 1행, 매 실행마다 통째로 덮어쓴다.
export async function writeSummary(summaryRows, detailRows, dimRows = []) {
  const client = getClient();
  if (!client) return false;
  const { sheets, spreadsheetId } = await client;
  const { summaryId, detailId } = await ensureTabs(sheets, spreadsheetId);

  await overwriteTab({ sheets, spreadsheetId, tab: SUMMARY_TAB, sheetId: summaryId, header: SUMMARY_HEADER, widths: SUMMARY_WIDTHS, rows: summaryRows, dimRows });
  await overwriteTab({ sheets, spreadsheetId, tab: DETAIL_TAB, sheetId: detailId, header: DETAIL_HEADER, widths: DETAIL_WIDTHS, rows: detailRows, dimRows });
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
      requestBody: { requests: formatRequests(logId, LOG_WIDTHS) },
    });
  }
  return true;
}
