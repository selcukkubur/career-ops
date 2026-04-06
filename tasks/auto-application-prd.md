# PRD: Auto-Application Pipeline

Extend career-ops Docker setup to fully automate job applications end-to-end.

## Current State

- ✅ JD extraction from URLs (Greenhouse, Lever, Ashby, Workday)
- ✅ AI evaluation with A-F scoring
- ✅ Report generation
- ✅ Draft application answers (Section G)
- ✅ Tracker updates
- ❌ No auto-fill of application forms
- ❌ No auto-submit
- ❌ No PDF CV generation in Docker
- ❌ No LinkedIn outreach

## Quality Gates

These commands must pass for every user story:
- `docker compose up -d` - Services start successfully
- `curl -s http://localhost:3000/health | grep '"status":"ok"'` - Health check passes
- `docker compose logs career-ops | grep -i error` - No errors in logs

For Playwright automation stories, also include:
- Verify form filling works with headless browser
- Test with at least one real ATS platform

## User Stories

### US-001: Add PDF CV generation endpoint
**Description:** As a candidate, I want to generate a tailored PDF CV from HTML templates so I can attach it to applications.

**Acceptance Criteria:**
- [ ] Add `POST /api/pdf/generate` endpoint that takes HTML content and returns PDF
- [ ] Use Puppeteer (already in Playwright image) to render HTML to PDF
- [ ] Support custom fonts from fonts/ directory
- [ ] Save generated PDF to output/ directory
- [ ] Return download URL in response
- [ ] Handle errors gracefully (invalid HTML, missing fonts)
- [ ] Docker health check passes
- [ ] pnpm lint passes (for any JS changes)

### US-002: Add application form extractor for Greenhouse
**Description:** As the system, I want to extract application form questions from Greenhouse job pages so I can generate answers.

**Acceptance Criteria:**
- [ ] Add `extractGreenhouseForm(url)` function in src/extractor.js
- [ ] Navigate to Greenhouse application page with Playwright
- [ ] Extract all form fields: text inputs, textareas, dropdowns, file uploads, radio buttons
- [ ] Return structured JSON: `{ fields: [{ name, type, label, required, options }] }`
- [ ] Handle multi-page forms (detect "Next" buttons)
- [ ] Handle Greenhouse's dynamic form rendering
- [ ] Test with at least one real Greenhouse application URL
- [ ] Docker health check passes

### US-003: Add application form extractor for Lever
**Description:** As the system, I want to extract application form questions from Lever job pages so I can generate answers.

**Acceptance Criteria:**
- [ ] Add `extractLeverForm(url)` function in src/extractor.js
- [ ] Navigate to Lever application page with Playwright
- [ ] Extract all form fields with same structure as Greenhouse
- [ ] Handle Lever's specific form patterns (often simpler than Greenhouse)
- [ ] Return structured JSON with same format
- [ ] Test with at least one real Lever application URL
- [ ] Docker health check passes

### US-004: Add application form extractor for Ashby
**Description:** As the system, I want to extract application form questions from Ashby job pages so I can generate answers.

**Acceptance Criteria:**
- [ ] Add `extractAshbyForm(url)` function in src/extractor.js
- [ ] Navigate to Ashby application page with Playwright
- [ ] Extract all form fields with same structure
- [ ] Handle Ashby's form patterns
- [ ] Return structured JSON with same format
- [ ] Test with at least one real Ashby application URL
- [ ] Docker health check passes

### US-005: Add application answer generator
**Description:** As the system, I want to generate personalized answers for application form questions using the candidate's profile and report context.

**Acceptance Criteria:**
- [ ] Add `POST /api/generate-answers` endpoint
- [ ] Accept input: `{ formFields: [...], reportContent: string, cvContent: string }`
- [ ] Use OpenAI to generate answers for each field based on type:
  - Text fields: Generate personalized answers using "I'm choosing you" tone
  - Dropdowns: Suggest best option from available choices
  - Yes/No: Determine best answer from candidate profile
  - Salary: Suggest range based on comp research from report
- [ ] Return `{ answers: [{ fieldName, value, confidence }] }`
- [ ] Follow tone rules from modes/auto-pipeline.md (confident, specific, 2-4 sentences)
- [ ] Docker health check passes

### US-006: Add auto-fill application for Greenhouse
**Description:** As the system, I want to automatically fill out Greenhouse application forms so the candidate can review and submit.

**Acceptance Criteria:**
- [ ] Add `POST /api/apply/greenhouse` endpoint
- [ ] Accept input: `{ applicationUrl: string, answers: [{ fieldName, value }] }`
- [ ] Launch Playwright browser and navigate to application URL
- [ ] Fill each form field with generated answer
- [ ] Handle field types: text input, textarea, select dropdown, radio, checkbox
- [ ] Handle file upload for resume (use generated PDF from US-001)
- [ ] Take screenshot of completed form for review
- [ ] Return `{ success: boolean, screenshotUrl: string, formUrl: string }`
- [ ] Do NOT auto-submit (leave for candidate review)
- [ ] Docker health check passes

### US-007: Add auto-fill application for Lever
**Description:** As the system, I want to automatically fill out Lever application forms so the candidate can review and submit.

**Acceptance Criteria:**
- [ ] Add `POST /api/apply/lever` endpoint
- [ ] Same functionality as US-006 but for Lever forms
- [ ] Handle Lever's specific form patterns
- [ ] Return same response format
- [ ] Do NOT auto-submit
- [ ] Docker health check passes

### US-008: Add auto-fill application for Ashby
**Description:** As the system, I want to automatically fill out Ashby application forms so the candidate can review and submit.

**Acceptance Criteria:**
- [ ] Add `POST /api/apply/ashby` endpoint
- [ ] Same functionality as US-006 but for Ashby forms
- [ ] Handle Ashby's specific form patterns
- [ ] Return same response format
- [ ] Do NOT auto-submit
- [ ] Docker health check passes

### US-009: Add full auto-apply endpoint (evaluate + fill)
**Description:** As a candidate, I want to send a job URL and get back a filled application form in one call.

**Acceptance Criteria:**
- [ ] Add `POST /api/auto-apply` endpoint
- [ ] Accept input: `{ urlOrJD: string, autoFill: boolean }`
- [ ] Execute full pipeline: extract JD → evaluate → generate answers → detect ATS → fill form
- [ ] Return `{ success, reportNum, score, formFilled: boolean, screenshotUrl, reviewUrl }`
- [ ] If autoFill is true, also fill the form (not submit)
- [ ] If autoFill is false, just generate answers without filling
- [ ] Handle errors at any step gracefully
- [ ] Docker health check passes

### US-010: Add LinkedIn outreach message generator
**Description:** As a candidate, I want to generate personalized LinkedIn outreach messages for recruiters/hiring managers.

**Acceptance Criteria:**
- [ ] Add `POST /api/linkedin/message` endpoint
- [ ] Accept input: `{ companyName: string, role: string, reportContent: string, recipientName: string, recipientTitle: string }`
- [ ] Generate connection request message (300 char limit)
- [ ] Generate follow-up message (longer, after connection accepted)
- [ ] Use "I'm choosing you" tone from modes/auto-pipeline.md
- [ ] Reference specific company/role details from report
- [ ] Return `{ connectionMessage: string, followupMessage: string }`
- [ ] Docker health check passes

### US-011: Add batch auto-apply endpoint
**Description:** As a candidate, I want to auto-apply to multiple jobs in one batch operation.

**Acceptance Criteria:**
- [ ] Add `POST /api/batch-apply` endpoint
- [ ] Accept input: `{ jobs: [{ urlOrJD: string }], autoFill: boolean }`
- [ ] Process jobs sequentially (to avoid rate limiting)
- [ ] For each job: evaluate → generate answers → fill form (if autoFill)
- [ ] Track progress and return status for each job
- [ ] Return `{ results: [{ success, reportNum, score, formFilled, error }] }`
- [ ] Add 5-second delay between jobs to avoid rate limiting
- [ ] Handle individual job failures without stopping the batch
- [ ] Docker health check passes

### US-012: Add application status dashboard API
**Description:** As a candidate, I want to view the status of all my applications via API.

**Acceptance Criteria:**
- [ ] Add `GET /api/applications` endpoint
- [ ] Return all applications from data/applications.md as JSON
- [ ] Include: company, role, score, status, report link, form filled status, date
- [ ] Support filtering by status: `?status=evaluated`
- [ ] Support sorting: `?sort=date&order=desc`
- [ ] Support pagination: `?page=1&limit=20`
- [ ] Return metadata: `{ total, page, limit, totalPages }`
- [ ] Docker health check passes