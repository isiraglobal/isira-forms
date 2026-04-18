/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  FOREIGN AFFAIRS — GOOGLE APPS SCRIPT                        ║
 * ║  Receives POST requests from the Cloudflare Worker and       ║
 * ║  writes to Google Sheets.                                    ║
 * ║                                                              ║
 * ║  SETUP INSTRUCTIONS:                                         ║
 * ║  1. Open script.google.com → New project                     ║
 * ║  2. Paste this entire file, replacing Code.gs content        ║
 * ║  3. Set SPREADSHEET_ID below (from your Sheet URL)           ║
 * ║  4. Deploy → New deployment → Web app                        ║
 * ║       Execute as: Me                                         ║
 * ║       Who has access: Anyone                                 ║
 * ║  5. Copy the Web App URL → paste into Cloudflare Worker env  ║
 * ║     variable APPS_SCRIPT_URL                                 ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

// ── CONFIGURE THIS ────────────────────────────────────────────────────────────
const SPREADSHEET_ID = 'YOUR_GOOGLE_SHEET_ID_HERE'; // From sheet URL
const VENUE_SHEET_NAME  = 'Venues';
const VENDOR_SHEET_NAME = 'Vendors';
const LOG_SHEET_NAME    = 'Activity Log';

// ── Column definitions ────────────────────────────────────────────────────────

const VENUE_COLUMNS = [
  // Identity & Status
  'Submission ID', 'Submitted At', 'Payment Status', 'Plan Paid', 'Whop Transaction ID', 'Paid At',
  // Venue Details
  'Venue Name', 'Venue Type', 'Venue Type Other',
  'Address', 'City', 'State', 'ZIP',
  // Space Specs
  'Square Footage', 'Max Capacity', 'Indoor/Outdoor', 'Parking Spaces',
  'Power Access (220V)', 'Loading Dock',
  // Amenities
  'Has Stage', 'Has Dance Floor', 'Has DJ Booth', 'Has Entertainment License', 'Has Sound System', 'Has Lighting System',
  // Legal Docs
  'COI', 'Occupancy Permit', 'Fire Marshal Permit', 'ADA Compliance', 'Business License',
  'Floor Plan', 'Liquor License', 'Food Service License', "Seller's Permit", 'Noise Permit',
  'Documents Confirmed',
  // Availability
  'Available Dates', 'Preferred Event Times', 'Preferred Event Type',
  // Social
  'Business Social Media', 'Personal Social Media',
  // Contact
  'First Name', 'Last Name', 'Full Name', 'Job Position', 'Email', 'Phone',
  'Is Decision Maker', 'Business Legal Name',
  // Notes
  'Notes',
  // Meta
  'Last Updated',
];

const VENDOR_COLUMNS = [
  // Identity & Status
  'Submission ID', 'Submitted At', 'Payment Status', 'Plan Paid', 'Amount Paid ($)', 'Whop Transaction ID', 'Paid At',
  // Business
  'Business Name', 'Category', 'Category Other', 'Description', 'Website', 'Instagram', 'Referral Code',
  // Event Selection
  'Registration Type', 'Selected Events', 'Selected Event Names', 'General Preferences',
  // Booth
  'Booth Size', 'Booth Size Label', 'Needs Power', 'Needs Table', 'Special Requirements',
  // Terms
  'Agreed to Terms',
  // Contact
  'First Name', 'Last Name', 'Full Name', 'Email', 'Phone',
  // Meta
  'Notes', 'Last Updated',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function getOrCreateSheet(ss, name, columns) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    // Style header row
    const headerRange = sheet.getRange(1, 1, 1, columns.length);
    headerRange.setValues([columns]);
    headerRange.setBackground('#0f0c08');
    headerRange.setFontColor('#c9a961');
    headerRange.setFontWeight('bold');
    headerRange.setFontSize(11);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 180);  // Submission ID
    sheet.setColumnWidth(2, 160);  // Submitted At
    sheet.setColumnWidth(3, 120);  // Payment Status
    Logger.log('Created sheet: ' + name);
  }
  return sheet;
}

function getOrCreateLogSheet(ss) {
  let sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    const headers = ['Timestamp', 'Action', 'Submission ID', 'Details'];
    const range   = sheet.getRange(1, 1, 1, headers.length);
    range.setValues([headers]);
    range.setBackground('#1e1a14');
    range.setFontColor('#c9a961');
    range.setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function appendLog(ss, action, submissionId, details) {
  try {
    const log = getOrCreateLogSheet(ss);
    log.appendRow([new Date().toISOString(), action, submissionId, details]);
  } catch(e) { Logger.log('Log write failed: ' + e.message); }
}

function findRowById(sheet, submissionId) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(submissionId)) return i + 1; // 1-indexed
  }
  return -1;
}

function updateCellByHeader(sheet, rowIndex, columns, header, value) {
  const colIndex = columns.indexOf(header);
  if (colIndex === -1) return;
  sheet.getRange(rowIndex, colIndex + 1).setValue(value);
}

function paintStatusCell(sheet, rowIndex, columns, status) {
  const colIndex = columns.indexOf('Payment Status');
  if (colIndex === -1) return;
  const cell = sheet.getRange(rowIndex, colIndex + 1);
  if (status === 'paid') {
    cell.setBackground('#dcfce7');
    cell.setFontColor('#15803d');
    cell.setFontWeight('bold');
  } else if (status === 'pending') {
    cell.setBackground('#fef9c3');
    cell.setFontColor('#854d0e');
    cell.setFontWeight('bold');
  } else {
    cell.setBackground('#fee2e2');
    cell.setFontColor('#991b1b');
  }
}

// ── Venue row builder ─────────────────────────────────────────────────────────
function buildVenueRow(data) {
  const d = data;
  return [
    // Identity & Status
    d.submissionId || '', d.submittedAt || '', d.paymentStatus || 'pending',
    d.planPaid || '', d.whopTransactionId || '', d.paidAt || '',
    // Venue
    d.venueName || '', d.venueType || '', d.venueTypeOther || '',
    d.address || '', d.city || '', d.state || '', d.zip || '',
    // Specs
    d.squareFootage || '', d.capacity || '', d.indoorOutdoor || '', d.parkingSpaces || '',
    d.powerAccess || 'No', d.loadingDock || 'No',
    // Amenities
    d.hasStage || 'No', d.hasDanceFloor || 'No', d.hasDJBooth || 'No',
    d.hasEntertainment || 'No', d.hasSoundSystem || 'No', d.hasLighting || 'No',
    // Docs (from documents object serialized)
    d['documents.certificateOfInsurance'] || d.certificateOfInsurance || 'No',
    d['documents.occupancyPermit']        || d.occupancyPermit        || 'No',
    d['documents.fireMarshalPermit']      || d.fireMarshalPermit      || 'No',
    d['documents.adaCompliance']          || d.adaCompliance          || 'No',
    d['documents.businessLicense']        || d.businessLicense        || 'No',
    d['documents.floorPlan']              || d.floorPlan              || 'No',
    d['documents.liquorLicense']          || d.liquorLicense          || 'No',
    d['documents.foodServiceLicense']     || d.foodServiceLicense     || 'No',
    d['documents.sellersPermit']          || d.sellersPermit          || 'No',
    d['documents.noisePermit']            || d.noisePermit            || 'No',
    d.documentsChecked || '',
    // Availability
    d.availableDates || '', d.preferredEventTimes || '', d.preferredEventType || '',
    // Social
    d.businessSocialMedia || '', d.personalSocialMedia || '',
    // Contact
    d.firstName || '', d.lastName || '',
    ((d.firstName || '') + ' ' + (d.lastName || '')).trim(),
    d.jobPosition || '', d.email || '', d.phone || '',
    d.isDecisionMaker || 'No', d.businessName || '',
    // Notes
    d.notes || '',
    // Meta
    new Date().toISOString(),
  ];
}

// ── Vendor row builder ────────────────────────────────────────────────────────
function buildVendorRow(data) {
  const d = data;
  return [
    // Identity & Status
    d.submissionId || '', d.submittedAt || '', d.paymentStatus || 'pending',
    d.planPaid || '', d.amountPaid || '', d.whopTransactionId || '', d.paidAt || '',
    // Business
    d.businessName || '', d.category || '', d.categoryOther || '',
    d.description || '', d.website || '', d.instagram || '', d.referralCode || '',
    // Events
    d.registrationType || '', d.selectedEvents || '', d.selectedEventNames || '',
    d.generalPreferences || '',
    // Booth
    d.boothSize || '', d.boothSizeLabel || '', d.needsPower || 'No',
    d.needsTable || 'No', d.specialRequirements || '',
    // Terms
    d.agreeToTerms || 'No',
    // Contact
    d.firstName || '', d.lastName || '',
    ((d.firstName || '') + ' ' + (d.lastName || '')).trim(),
    d.email || '', d.phone || '',
    // Meta
    d.notes || '',
    new Date().toISOString(),
  ];
}

// ── Main POST handler ─────────────────────────────────────────────────────────
function doPost(e) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'Invalid JSON' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const action       = data.action || 'submit';
  const submissionId = data.submissionId || '';
  const type         = data.type || ''; // 'venue' | 'vendor'

  try {
    // ── ACTION: submit — new form submission ──────────────────────────────────
    if (action === 'submit') {
      if (type === 'venue') {
        const sheet = getOrCreateSheet(ss, VENUE_SHEET_NAME, VENUE_COLUMNS);
        const row   = buildVenueRow(data);
        sheet.appendRow(row);
        // Style the new row's status cell
        const newRowIndex = sheet.getLastRow();
        paintStatusCell(sheet, newRowIndex, VENUE_COLUMNS, 'pending');
        appendLog(ss, 'VENUE_SUBMIT', submissionId, 'New venue application: ' + (data.venueName || ''));
      } else if (type === 'vendor') {
        const sheet = getOrCreateSheet(ss, VENDOR_SHEET_NAME, VENDOR_COLUMNS);
        const row   = buildVendorRow(data);
        sheet.appendRow(row);
        const newRowIndex = sheet.getLastRow();
        paintStatusCell(sheet, newRowIndex, VENDOR_COLUMNS, 'pending');
        appendLog(ss, 'VENDOR_SUBMIT', submissionId, 'New vendor: ' + (data.businessName || '') + ' | ' + (data.email || ''));
      }
      return ContentService.createTextOutput(JSON.stringify({ ok: true, action }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ── ACTION: payment_confirm / whop_webhook — update status ───────────────
    if (action === 'payment_confirm' || action === 'whop_webhook') {
      const statusVal = data.paymentStatus || 'paid';
      const planVal   = data.planPaid      || '';
      const txVal     = data.whopTransactionId || '';
      const paidAt    = data.paidAt        || new Date().toISOString();
      const modeVal   = data.mode          || type;
      const amountVal = data.amountPaid    || '';

      // Try venue sheet first, then vendor
      let updated = false;
      const sheets = [
        { sheet: getOrCreateSheet(ss, VENUE_SHEET_NAME, VENUE_COLUMNS),  cols: VENUE_COLUMNS  },
        { sheet: getOrCreateSheet(ss, VENDOR_SHEET_NAME, VENDOR_COLUMNS), cols: VENDOR_COLUMNS },
      ];

      for (const { sheet, cols } of sheets) {
        const rowIdx = findRowById(sheet, submissionId);
        if (rowIdx === -1) continue;
        updated = true;

        updateCellByHeader(sheet, rowIdx, cols, 'Payment Status',      statusVal);
        updateCellByHeader(sheet, rowIdx, cols, 'Plan Paid',           planVal);
        updateCellByHeader(sheet, rowIdx, cols, 'Whop Transaction ID', txVal);
        updateCellByHeader(sheet, rowIdx, cols, 'Paid At',             paidAt);
        updateCellByHeader(sheet, rowIdx, cols, 'Last Updated',        new Date().toISOString());
        if (amountVal) updateCellByHeader(sheet, rowIdx, cols, 'Amount Paid ($)', amountVal);

        paintStatusCell(sheet, rowIdx, cols, statusVal);
        appendLog(ss, action.toUpperCase(), submissionId, `Status → ${statusVal} | Plan: ${planVal} | TX: ${txVal}`);
        break;
      }

      if (!updated) {
        appendLog(ss, action.toUpperCase() + '_NOT_FOUND', submissionId, 'Row not found in either sheet');
      }

      return ContentService.createTextOutput(JSON.stringify({ ok: true, updated, action }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Unknown action
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'Unknown action: ' + action }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch(err) {
    appendLog(ss, 'ERROR', submissionId, err.message);
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ── GET handler (health check) ────────────────────────────────────────────────
function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    status: 'ok',
    service: 'Foreign Affairs Apps Script',
    ts: new Date().toISOString(),
  })).setMimeType(ContentService.MimeType.JSON);
}
