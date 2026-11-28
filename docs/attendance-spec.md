# PROJECT HANDOVER: PAYROLL PORTAL – ATTENDANCE & LEAVE MANAGEMENT SYSTEM

**Prepared for:** Claude (AI Development Assistant)  
**Project:** Extension of existing School Payroll Portal  
**Organisation:** Multi-campus educational institution  
**Primary users:** Director, Administrators and Employees  
**Initial workforce:** Approximately 50 employees  
**Timezone:** Asia/Kolkata (IST)  
**Document status:** Consolidated requirements and implementation specification

---

# 1. PROJECT OBJECTIVE

We have an existing Payroll Portal. We want to extend it by adding a fully customised Attendance and Leave Management System.

This must be an integrated module inside the existing Payroll Portal, NOT a separate application.

The system must support:

1. WhatsApp-based employee attendance.
2. GPS-based campus geofencing.
3. Live selfie capture through a secure web page.
4. Automated face matching against employee reference photographs.
5. Real-time attendance updates.
6. Instant notifications to the Director.
7. Employee-wise attendance tracking and statistics.
8. Leave applications and approvals.
9. A maximum of two leave applications per campus per date.
10. Permission management.
11. Upcoming leave calendar.
12. Multi-campus working calendars.
13. Payroll and LOP integration.
14. Downloadable Excel reports for administrators.

The system must be economical, reliable, maintainable and easy to use.

**Important development philosophy:** Do not overengineer the solution. Prefer straightforward, proven technologies and open-source components where practical. Avoid unnecessary paid API subscriptions.

---

# 2. EXISTING TECHNOLOGY AND PROJECT PRESERVATION

The existing Payroll Portal uses:

- Frontend: Inspect the existing implementation.
- Backend: Netlify Functions.
- Database: Supabase PostgreSQL.
- Authentication: Existing authentication implementation.
- Hosting: Netlify.
- Repository: Existing private GitHub repository.

Do not assume the frontend framework or existing database schema. Inspect the actual repository.

## Critical preservation requirements

Do NOT disturb:

- Existing employee records and employee IDs.
- Existing salary structures.
- Existing payroll calculations.
- Existing payslip generation.
- Existing authentication and authorisation.
- Existing WhatsApp payment-receipt workflow.
- Existing payroll reports.
- Existing production database records.

The new module must reuse existing employee records wherever possible.

Do not create duplicate employee masters.

All schema changes must be introduced through controlled, versioned database migrations.

Before making changes:
- Inspect the repository.
- Inspect the database schema.
- Understand existing payroll calculations.
- Understand existing WhatsApp integration.
- Identify all dependencies.
- Prepare a migration and rollback plan.

Never directly modify production without testing migrations in a staging environment.

---

# 3. EMPLOYEE INTERFACE – WHATSAPP

Employees will interact with the attendance and leave system through the school's existing WhatsApp Business number.

The same number must continue to support parent communication and general school communication.

Use WhatsApp Business App + Cloud API Coexistence, subject to Meta eligibility.

Do not migrate, deregister or delete the existing WhatsApp number before verifying Coexistence eligibility.

## Supported employee commands

| Command | Function |
|---|---|
| IN | Mark attendance check-in |
| OUT | Mark attendance check-out |
| LEAVE | Apply for leave |
| PERMISSION | Apply for permission |
| BALANCE | Check leave balance |
| HELP | Display available commands |

Requirements:

- Only registered employee phone numbers can use employee services.
- Unregistered numbers must not be allowed to mark attendance.
- WhatsApp private conversations only.
- Do not use WhatsApp groups for attendance.
- Parent/general messages must not trigger employee attendance workflows.
- Prevent webhook loops and duplicate message processing.
- Employee receives confirmation for successful attendance and leave actions.

WhatsApp API credentials must be stored securely in Netlify environment variables, never in frontend code.

---

# 4. ATTENDANCE MANAGEMENT

## 4.1 Working hours and late policy

| Parameter | Policy |
|---|---|
| Official reporting time | 9:00 AM |
| Grace period | 10 minutes |
| On-time arrival | Up to and including 9:10 AM |
| Late arrival | After 9:10 AM |
| Late occurrence | One per employee per working day |
| Check-out | Mandatory |
| Timezone | Asia/Kolkata |

Late arrivals must be recorded cumulatively.

There is currently NO automatic LOP for late arrivals.

Late-to-LOP conversion is not part of the initial implementation.

## 4.2 Check-in and check-out workflow

Both IN and OUT must follow the same secure attendance-link workflow.

Employee journey:

1. Employee sends IN or OUT through WhatsApp.
2. Backend identifies the employee through their registered WhatsApp number.
3. Backend generates a unique, secure, short-lived attendance link.
4. Employee opens the link in their mobile browser.
5. Browser requests location permission.
6. GPS location is captured.
7. Campus geofence is checked.
8. Browser requests camera permission.
9. Employee captures a fresh selfie.
10. Face matching is performed against the employee's enrolled reference photo.
11. Backend validates the result.
12. Attendance is recorded using the server timestamp.
13. Employee receives WhatsApp confirmation.
14. Director's dashboard updates immediately.

Do not ask employees to send selfies as WhatsApp attachments.

Do not accept attendance based on WhatsApp text alone.

## 4.3 Secure attendance link

The attendance link must:

- Be unique to the attendance session.
- Be associated with the correct employee.
- Be associated with the correct campus.
- Specify IN or OUT.
- Expire after approximately five minutes.
- Be single-use.
- Be protected against replay and duplicate submissions.
- Be validated on the backend.
- Never expose sensitive employee or biometric information.

Use cryptographically secure random tokens, server-side validation, nonce/idempotency protection and appropriate session expiry.

## 4.4 GPS geofencing

Each campus must have its own registered latitude and longitude.

Geofence radius must be configurable independently for every campus.

The user has asked about a 5-metre radius. However, ordinary mobile GPS can be inaccurate, particularly inside buildings.

Therefore:

- Retain a configurable 5-metre target.
- Test actual campus entrances using different Android and iPhone devices.
- Recommend starting with a practical 25-metre acceptance radius unless pilot measurements justify a stricter setting.
- Record reported GPS accuracy.
- Initially target GPS accuracy of 10 metres or better.
- Flag poor GPS accuracy or ambiguous boundary cases for retry/manual review.
- Do not silently accept inaccurate coordinates.
- Do not continuously track employees.

GPS coordinates can be spoofed. Geofencing is a location control, not proof of identity.

Only employees assigned to the campus or holding an authorised temporary campus assignment may mark attendance there.

## 4.5 Biometric verification – selected approach A

The user has selected the practical and economical option.

The required verification is:

- Fresh selfie capture.
- Automated 1:1 face matching against an enrolled employee reference photograph.
- No mandatory paid liveness API at initial launch.
- No custom facial recognition model development.
- No unnecessary 3D facial recognition infrastructure.

A separate liveness solution may be considered later if affordable and justified.

IMPORTANT:

Without a dedicated liveness layer, face matching is vulnerable to certain photo and screen-replay attacks. Do not claim that selfie plus face matching is spoof-proof.

Implement:
- Secure employee photo enrollment.
- Server-side face comparison.
- Face-match confidence result.
- Configurable verification thresholds established through testing.
- Retry handling.
- Manual review for inconclusive results.
- Alternative attendance procedure when verification fails.

Do not automatically deduct salary or mark an employee absent because face verification failed.

### Possible implementation components

Evaluate:

1. CompreFace – open-source face matching.
2. Open-source liveness models – optional future enhancement.
3. MediaPipe – optional browser-side face detection and capture-quality checks.

MediaPipe is NOT a complete facial recognition or secure liveness system. Do not use blinking or head movement alone as proof of liveness.

Prefer self-hosted processing where practical to avoid per-verification API charges.

Before selecting any model:
- Verify the licence for code and pretrained weights.
- Check commercial-use permissions.
- Benchmark accuracy.
- Test printed photographs.
- Test another phone displaying a photograph.
- Test replayed video.
- Test different lighting and phone cameras.
- Review security and maintenance requirements.

Do not deploy an experimental biometric model into production without testing.

## 4.6 Biometric data protection

- Reference photographs must be securely enrolled.
- Do not use WhatsApp profile photographs as biometric references.
- Keep biometric storage private.
- Encrypt stored biometric information.
- Restrict access to authorised personnel.
- Do not send selfies to the Director through WhatsApp.
- Store verification outcomes in attendance records.
- Establish a documented retention and deletion policy.
- Maintain biometric access audit logs.
- Provide an appropriate privacy notice and legal basis for processing.
- Provide a manual alternative for employees who cannot complete biometric verification.

---

# 5. ATTENDANCE BUSINESS RULES

- One valid IN and OUT per employee per working day under normal operation.
- Duplicate submissions must not create duplicate attendance records.
- Use server timestamps, not client device time.
- Missing OUT must create an attendance exception.
- Employees who have not checked in must display as UNMARKED.
- Do not automatically mark unmarked employees absent.
- Approved leave, holidays and weekly offs must be excluded from expected attendance.
- Authorised campus duty must be recognised.
- Corrections must be handled through authorised adjustment records.
- Preserve original attendance events.
- Maintain an audit trail.

---

# 6. LIVE MANAGEMENT DASHBOARD

The Director and authorised administrators must have a real-time web dashboard.

## Main dashboard sections

### Attendance summary

- Total active employees.
- Present.
- Late.
- Unmarked.
- On Leave.
- Pending verification/review.
- Campus-wise attendance.

### Live attendance activity

Display each successful event immediately:

- Employee name.
- Employee ID.
- Department.
- Campus.
- Check-in/check-out.
- Timestamp.
- On-time/late status.
- GPS verification result.
- Face verification result.

### Unmarked employees

Display employees expected to report but who have not checked in.

Exclude:
- Approved leave.
- Weekly offs.
- Holidays.
- Authorised campus duty.

The list must update automatically as employees check in.

### Attendance exceptions

Display:
- GPS failures.
- Poor GPS accuracy.
- Face verification failures.
- Incomplete verification.
- Missing check-outs.
- Duplicate or suspicious submissions.

Provide a manual review workflow.

## 6.1 Real-time updates

Use Supabase Realtime or the existing equivalent architecture.

The dashboard must update without manual browser refresh.

The Director must receive individual WhatsApp notifications for:

- Every successful check-in.
- Every successful check-out.
- Late arrivals.
- Verification exceptions.
- Missing check-outs.
- Leave and permission requests.

Notifications must contain employee details, campus, time, status and portal link.

Never attach biometric selfies to WhatsApp notifications.

Also provide a live activity feed and configurable consolidated attendance summaries.

---

# 7. EMPLOYEE-WISE ATTENDANCE TRACKING

Every employee name displayed in the dashboard or attendance tracking section must be clickable.

Clicking the name opens that employee's detailed profile.

## 7.1 Employee profile

Display:

- Employee photograph or profile icon.
- Employee name.
- Employee ID.
- Department.
- Designation.
- Campus.
- Employment status.

## 7.2 Month and year filters

Provide dropdown controls for:

- Month: January to December.
- Year: Available historical years.

Changing the month/year must refresh all displayed statistics.

## 7.3 Monthly employee statistics

Display:

- Total working days.
- Present days.
- On-time arrivals.
- Late arrivals.
- Approved leave days.
- Unpaid leave days.
- Unmarked days.
- Missing check-outs.
- Average check-in time.
- Leave balance.
- Permission count.
- LOP days.

Include an attendance percentage and visual statistics.

## 7.4 Detailed employee history

Provide:

- Monthly attendance calendar.
- Daily IN and OUT times.
- Late arrival history.
- Location verification status.
- Face verification status.
- Leave application history.
- Leave balance ledger.
- Permission history.
- Payroll impact.

Sensitive biometric images must not be exposed through the ordinary employee profile.

Provide an employee-specific Excel download.

---

# 8. LEAVE MANAGEMENT

Employees can apply for leave through WhatsApp using LEAVE.

The system must support the following four categories:

1. Casual Leave.
2. Sick Leave.
3. Earned Leave.
4. Unpaid Leave.

Monthly leave entitlement is NOT YET DECIDED.

Implement entitlement as configurable policy settings. Do not hardcode a monthly entitlement.

## 8.1 Leave application information

Capture:

- Employee.
- Leave category.
- Start date.
- End date.
- Full-day or half-day.
- Reason.
- Supporting attachment, if required by policy.

## 8.2 Mandatory rule: Maximum two employees per campus per date

This is a critical business rule.

Maximum two employees may have leave applications counted against a particular campus on a particular date.

The count includes:
- Pending applications.
- Approved applications.

The count excludes:
- Rejected applications.
- Cancelled applications.

### Required workflow

When an employee submits a leave application:

1. Identify the employee and campus.
2. Check the requested date or dates.
3. Count pending and approved leave applications for that campus on each requested date.
4. If capacity is available on all requested dates, accept the application and forward it to the Director.
5. If any requested date has already reached the maximum of two, reject the entire application automatically.
6. Do not forward rejected applications to the Director.
7. Send an immediate WhatsApp notification explaining the reason.

### Employee notification

"Sorry, leave applications for this date have reached the maximum permitted limit of two employees for your campus.

Your leave application has not been forwarded to the Director.

Please select another date or contact the school administration."

### Technical enforcement

This rule MUST be enforced transactionally at database level.

Do not rely on frontend checks alone.

Prevent concurrent submissions from exceeding the limit.

For multi-day applications, validate every requested date separately.

If one date exceeds capacity, reject the entire application rather than partially submitting it.

Rejected applications must be retained for audit but must not count towards the limit.

Cancelled applications must release their capacity.

A cancelled approved leave must have an appropriate leave-ledger reversal.

## 8.3 Leave approval workflow

- All eligible applications go to the Director.
- Director is the sole leave approval authority.
- System administrators cannot approve leave merely because they have technical administrator privileges.
- Director receives WhatsApp notification.
- Director can approve or reject from the portal.
- Employee receives WhatsApp notification of the decision.
- Only approved leave is deducted from the leave balance.
- Rejected applications do not deduct leave.
- Cancellation of approved leave creates an auditable reversal.

---

# 9. LEAVE BALANCE MANAGEMENT

Implement a leave ledger.

Required records:

- Opening balance.
- Monthly credit.
- Approved leave deduction.
- Reversal.
- Manual adjustment.
- Closing balance.

The ledger must be the source of truth.

Do not calculate balances by simply counting approved requests without accounting for credits, reversals and adjustments.

Requirements:

- Monthly entitlement configurable.
- Leave category-wise balances.
- Employee-wise history.
- No negative balance unless explicitly permitted by policy.
- Historical records preserved.
- Monthly entitlement remains undecided until the user confirms it.

---

# 10. UPCOMING LEAVE CALENDAR

Include both:

1. Employees on Leave Today.
2. Upcoming Approved Leaves.

Upcoming leave visibility is restricted to:

- Director.
- Administrator.

Do not expose the upcoming leave calendar to ordinary employees or department heads.

## Filters

- Next 7 days.
- Next 15 days.
- Next 30 days.
- Custom date range.
- Campus.
- Department.
- Employee.

Display:

- Employee name.
- Employee ID.
- Designation.
- Department.
- Campus.
- Leave category.
- Leave dates.
- Full-day/half-day.
- Approval status.

Highlight overlapping leave in departments and possible staffing shortages.

Pending leave requests must be shown separately from approved leaves.

Update the calendar automatically when applications are approved, rejected or cancelled.

---

# 11. PERMISSION MANAGEMENT

Employees can apply for permission through WhatsApp using PERMISSION.

Capture:

- Date.
- Start time.
- End time or duration.
- Reason.
- Supporting details, if necessary.

Workflow:

- Director-only approval.
- WhatsApp notification to Director.
- Approval/rejection through portal.
- WhatsApp response to employee.
- Permission history retained.
- Permissions displayed in employee profile and reports.

Permissions are separate from leave.

Do not automatically convert permission hours into LOP unless a future policy explicitly requires it.

---

# 12. CAMPUS AND WORKING CALENDAR MANAGEMENT

Support multiple campuses.

Each campus must have:

- Campus name.
- Campus code.
- Address.
- Latitude/longitude.
- Configurable geofence radius.
- Active/inactive status.

Working calendars must be independently configurable by campus.

Support:

- Working weekdays.
- Weekly offs.
- Public holidays.
- School holidays.
- Special working Saturdays.
- Campus closures.
- Examination days.
- School events.
- Custom working days.
- Employee shifts.
- Temporary campus duty assignments.

Attendance and LOP calculations must use the relevant employee's applicable campus calendar.

---

# 13. PAYROLL INTEGRATION

The new module must integrate with existing payroll logic.

Generate monthly payroll attendance summaries containing:

- Employee ID.
- Employee name.
- Working days.
- Present days.
- Approved leave.
- Paid leave.
- Unpaid leave.
- LOP days.
- Late occurrence count.
- Missing attendance exceptions.
- Permission summary.

LOP must be calculated using actual working days of the relevant month, consistent with the existing payroll rules.

Do not overwrite existing payroll calculations without first inspecting their implementation.

Payroll must use approved and finalised attendance records.

Once monthly payroll is finalised:
- Prevent unauthorised retrospective changes.
- Require authorised reopening for corrections.
- Maintain a complete audit trail.

Do not allow late-arrival counts to create automatic LOP under the current policy.

---

# 14. ADMIN EXCEL REPORTING

Add a dedicated Reports & Excel Exports section.

Administrators and the Director must be able to download `.xlsx` reports.

## Required reports

1. Daily Attendance Report.
2. Monthly Attendance Report.
3. Late Arrivals Report.
4. Leave Register.
5. Leave Balance Report.
6. Upcoming Leaves Report.
7. Permission Register.
8. LOP Report.
9. Campus-wise Attendance Report.
10. Department-wise Attendance Report.
11. Employee-wise Attendance History.
12. Payroll Attendance Summary.

## Export controls

- Date range.
- Month/year dropdown.
- Campus filter.
- Department filter.
- Employee filter.
- Report type.

## Excel formatting

- Proper column headings.
- Formatted dates and times.
- Totals and summary sheets.
- Separate detailed data worksheets.
- Clear leave and attendance statuses.
- Export timestamp.
- Selected filters.
- Consistent formatting.

Use Excel strictly for reporting.

Supabase remains the source of truth.

Log who downloaded which report and when.

Restrict exports according to role and campus access.

---

# 15. SECURITY AND AUTHORISATION

Use role-based access control.

Roles:

1. Director.
2. Administrator.
3. Employee.

## Director

- Full management visibility.
- All-campus attendance.
- All leave and permission approvals.
- Upcoming leave calendar.
- Employee profiles.
- Reports.
- Manual attendance review.
- Authorised corrections.

## Administrator

- Technical and operational configuration.
- Campus and employee management, subject to existing role permissions.
- Attendance monitoring.
- Upcoming leave calendar.
- Reports.
- System configuration.

Administrator must NOT automatically receive leave approval authority.

## Employee

- Own attendance.
- Own leave application.
- Own leave balance.
- Own permission requests.
- Own attendance history.

Use Supabase Row Level Security.

Do not trust frontend role checks alone.

Enforce Director-only approvals at backend/database level.

Keep Supabase service-role credentials server-side only.

Maintain audit logs for:
- Attendance events.
- Leave requests.
- Approvals.
- Rejections.
- Cancellations.
- Adjustments.
- Biometric verification.
- Report exports.
- Administrative changes.

---

# 16. PROPOSED DATABASE MODULES

Inspect the actual existing database first and adapt these groups to the existing schema.

Do not blindly create duplicate tables.

### Organisation

- campuses
- departments
- employee_campus_assignments
- working_calendars
- calendar_dates

### Attendance

- attendance_events
- daily_attendance
- attendance_exceptions
- attendance_adjustments
- attendance_verification_sessions
- attendance_verification_attempts

### Leave

- leave_types
- leave_policies
- leave_requests
- leave_request_days
- leave_ledger
- leave_balances

### Permissions and approvals

- permission_requests
- approvals
- approval_comments

### WhatsApp

- whatsapp_messages
- whatsapp_webhook_events
- notification_outbox

### Biometric

- employee_biometric_profiles
- biometric_enrollment_records
- biometric_authorization_records
- biometric_access_logs

### Security and configuration

- audit_logs
- system_settings
- payroll_attendance_summaries

Use existing employee IDs as foreign keys.

Use appropriate indexes, constraints and transactional database functions.

Use PostGIS if already available or justified for geofence distance checks.

Use append-only attendance events and adjustment records rather than silently overwriting historical events.

The two-employee leave cap must be enforced transactionally.

Leave deductions must be posted only after Director approval.

---

# 17. REAL-TIME NOTIFICATIONS

Implement a reliable notification-outbox pattern.

Required notifications:

### To employees

- Attendance link.
- Successful IN.
- Successful OUT.
- Failed attendance verification.
- Leave application accepted.
- Leave application rejected because of the two-employee limit.
- Leave approval.
- Leave rejection.
- Permission approval/rejection.

### To Director

- Successful IN.
- Successful OUT.
- Late arrivals.
- GPS failures.
- Face verification exceptions.
- Missing check-outs.
- Eligible leave requests.
- Permission requests.
- Relevant system exceptions.

Prevent duplicate messages using WhatsApp message IDs and idempotency keys.

Respect WhatsApp template requirements and customer-service messaging windows.

---

# 18. USER INTERFACE REQUIREMENTS

The portal must look professional and be easy to use.

Prioritise:

- Clean dashboard.
- Responsive mobile layout.
- Clear status indicators.
- Clickable employee names.
- Employee-wise statistics.
- Month/year dropdowns.
- Search and filters.
- Real-time dashboard updates.
- Downloadable reports.
- Clear error and success messages.

Do not make the interface unnecessarily complicated.

---

# 19. IMPLEMENTATION ROADMAP

Implement in stages.

### Phase 1 – Existing system assessment

- Inspect repository.
- Inspect frontend and backend.
- Inspect Supabase database.
- Identify employee master.
- Identify payroll logic.
- Identify existing WhatsApp integration.
- Prepare architecture document.
- Prepare migration plan.

Deliverable: Existing-system assessment and implementation blueprint.

### Phase 2 – Core attendance

- Campus configuration.
- Employee-campus assignments.
- Secure WhatsApp attendance link.
- GPS verification.
- Selfie capture.
- Face matching.
- Attendance recording.
- Employee confirmation.

### Phase 3 – Live management dashboard

- Present.
- Late.
- Unmarked.
- On Leave.
- Campus filters.
- Live attendance activity.
- Individual Director notifications.
- Exceptions.

### Phase 4 – Employee tracking

- Clickable employee names.
- Employee profile.
- Month/year filters.
- Attendance statistics.
- Attendance calendar.
- Leave and permission history.
- Employee-specific reports.

### Phase 5 – Leave management

- Four leave categories.
- Leave applications.
- Two-employee-per-campus-per-date rule.
- Automatic rejection notifications.
- Director approval.
- Leave ledger.
- Leave balance.

### Phase 6 – Permissions and calendars

- Permission applications.
- Director approvals.
- Campus calendars.
- Working days and holidays.
- Special Saturdays.

### Phase 7 – Upcoming leaves and reports

- On Leave Today.
- Upcoming Leaves.
- Director/Admin visibility.
- Overlapping leave alerts.
- Excel downloads.

### Phase 8 – Payroll integration

- Monthly attendance summary.
- LOP integration.
- Payroll finalisation controls.
- Historical reconciliation.

### Phase 9 – Security and deployment

- RLS testing.
- Role-based authorisation.
- WhatsApp webhook security.
- Biometric testing.
- Backup and recovery.
- Staging deployment.
- Pilot.
- Production deployment.

---

# 20. ACCEPTANCE TESTS

Before production deployment, verify all the following.

### Attendance

- Registered employee can initiate IN and OUT.
- Unregistered number cannot mark attendance.
- Attendance link expires.
- Attendance link cannot be reused.
- Correct campus geofence is applied.
- Outside-geofence attendance is not automatically accepted.
- Fresh selfie is required.
- Face matching works against the correct reference.
- Poor-quality captures are handled.
- Duplicate submissions do not create duplicate attendance.
- Server timestamp is authoritative.
- Director receives successful attendance notifications.
- Dashboard updates without refreshing.

### Late policy

- 9:10 AM is on time.
- 9:11 AM is late.
- One late occurrence per working day.
- No automatic LOP for late arrival.

### Leave

- Four leave categories available.
- Only Director can approve.
- Two pending/approved applications per campus per date.
- Third application is automatically rejected.
- Rejected application is not sent to Director.
- Employee receives rejection notification.
- Rejected/cancelled applications do not count towards the cap.
- Multi-day applications are checked date by date.
- Simultaneous requests cannot exceed the limit.
- Approved leave deducts balance.
- Cancellation reverses deduction.
- Pending leave does not deduct balance.

### Upcoming leaves

- Visible to Director and Administrator only.
- Approved leave displayed.
- Pending leave separately displayed.
- Filters work.
- Cancellations update the calendar.

### Employee profile

- Clicking employee name opens profile.
- Month and year dropdowns work.
- Statistics refresh correctly.
- Historical records are available.
- Employee Excel report works.

### Payroll

- Existing payroll calculations remain intact.
- LOP uses actual working days according to existing policy.
- Finalised payroll cannot be modified without authorisation.
- Existing payslip generation remains functional.

### Existing functionality

- Existing authentication works.
- Existing employee records remain intact.
- Existing payroll works.
- Existing WhatsApp payment-receipt workflow works.
- Parent/general WhatsApp communication remains unaffected.

---

# 21. DEVELOPMENT INSTRUCTIONS TO CLAUDE

You are acting as the senior full-stack architect and implementation engineer for this project.

Follow these instructions strictly.

1. Do not start by rewriting the application.
2. First inspect the entire existing repository.
3. Understand the current database and payroll logic.
4. Identify existing reusable components.
5. Identify risks to current production functionality.
6. Produce an implementation plan before making code changes.
7. Use small, incremental and reversible migrations.
8. Preserve existing employee IDs and relationships.
9. Reuse the existing authentication system.
10. Do not expose secrets in frontend code.
11. Do not create unnecessary duplicate services.
12. Prefer simple and maintainable architecture.
13. Use open-source components where commercially permissible.
14. Avoid unnecessary paid API subscriptions.
15. Do not introduce experimental biometric code into production without testing.
16. Never make an automatic payroll deduction based solely on failed biometric verification.
17. Test concurrency for the two-employee leave rule.
18. Test all role permissions at database and backend level.
19. Preserve the existing WhatsApp payment-receipt workflow.
20. Do not deploy directly to production without staging validation and user approval.

## Expected initial response from Claude

After examining the repository, provide:

A. Existing architecture summary.

B. Existing database schema summary.

C. Existing employee and payroll data relationships.

D. Existing WhatsApp integration analysis.

E. Proposed new module architecture.

F. Database migration plan.

G. Security and privacy risk assessment.

H. Biometric implementation recommendation and actual recurring cost estimate.

I. Development roadmap with dependencies.

J. List of issues requiring user decisions.

Do not start making production changes until the assessment and migration plan have been reviewed.

---

# 22. REMAINING POLICY DECISIONS

The following items remain configurable or undecided:

1. Exact monthly leave entitlement.
2. Leave carry-forward policy.
3. Final campus geofence acceptance radius after device testing.
4. Final face-matching technology after benchmarking.
5. Whether to introduce dedicated liveness detection in a later phase.
6. Biometric image retention duration.
7. Permission duration and any future LOP conversion policy.
8. Final WhatsApp Coexistence eligibility.
9. Employee biometric enrollment and privacy notice process.

Do not invent answers for these items. Keep them configurable where appropriate and request confirmation when necessary.

---

# FINAL PROJECT PRINCIPLE

Build a customised, reliable and economical Attendance & Leave Management System inside the existing Payroll Portal.

The employee should experience a simple WhatsApp workflow.

The Director should have complete, real-time visibility of attendance, leave, permissions and employee statistics.

The Administrator should have operational controls and downloadable Excel reports.

The existing payroll system and payment-receipt workflow must remain fully functional.

**Simplicity, reliability, security, affordability and maintainability take priority over unnecessary technical complexity.**
