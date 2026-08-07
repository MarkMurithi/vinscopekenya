# VinScope Kenya Legal Review Packet

Status: Pending external counsel review and approval.
Owner: Product/Engineering
Scope: Privacy Policy + Terms of Service text in src/App.jsx

## Important Note
This packet is not legal advice. It is a technical handoff artifact to speed up review by qualified legal counsel.

## Documents To Review
- Privacy Policy content source: src/App.jsx (privacyPolicySections)
- Terms of Service content source: src/App.jsx (termsOfServiceSections)
- Effective date label: src/App.jsx (LEGAL_LAST_UPDATED)

## Mandatory Counsel Decisions (Blocker Items)
1. Data controller identity
- Confirm legal entity name, registration details, and official contact channels.
- Confirm privacy contact mailbox ownership and SLA.

2. Jurisdiction and dispute resolution
- Confirm governing law text and whether arbitration/mediation is required before court action.
- Confirm whether exclusive jurisdiction language is acceptable for consumer protection rules.

3. Consumer refunds and cancellations
- Confirm refund wording for paid plans under Kenyan consumer law.
- Confirm cancellation timeline and prorated treatment.

4. Accuracy and liability disclaimers
- Confirm limitation/disclaimer language for third-party vehicle data is enforceable and fair.
- Confirm any mandatory statutory carve-outs that must be added.

5. Data retention schedule
- Replace generic retention statement with concrete retention windows per data category.
- Confirm legal-hold and tax/audit retention requirements.

6. Data subject rights workflow
- Confirm the process and response timelines for access, correction, deletion, and objection.
- Confirm identity verification requirements for rights requests.

7. International transfers/processors
- Confirm whether data leaves Kenya and whether transfer safeguards must be disclosed.
- Confirm processor list disclosure requirements.

8. Security and incident notification
- Confirm wording on security controls and breach notification obligations.

9. Minor users
- Confirm age threshold and parental consent requirements under applicable law.

10. Marketing/communications consent
- Confirm distinction between service messages and marketing messages.
- Confirm opt-in/opt-out requirements and records needed.

## Suggested Redline Areas In Current Text
1. Privacy section "Data Retention"
- Replace broad wording with category-specific retention windows.

2. Privacy section "How We Share Information"
- Add clearer processor/subprocessor categories and legal basis.

3. Privacy section "Your Rights"
- Add request channel, verification steps, and response timelines.

4. Terms section "Subscription Plans & Payments"
- Add cancellation flow, renewal terms, chargeback handling, and refund exceptions by law.

5. Terms section "Limitation of Liability"
- Add explicit statutory rights carve-out language where required.

6. Terms section "Termination"
- Add clear effect of termination on saved reports, sessions, and billing.

## Engineering Follow-ups After Counsel Review
1. Update LEGAL_LAST_UPDATED in src/App.jsx to counsel-approved date.
2. Replace placeholder legal contact emails/addresses with final approved details.
3. Add consent versioning in backend records (if counsel requires explicit acceptance logs by version).
4. Add user-facing Data Rights actions in account settings (export/delete request) if required by counsel.
5. Add release note entry: legal policy version change + effective date.

## Approval Checklist
- [ ] External counsel reviewed Privacy Policy text.
- [ ] External counsel reviewed Terms of Service text.
- [ ] Counsel comments incorporated in source text.
- [ ] Final legal version/date approved.
- [ ] Product owner sign-off recorded.
- [ ] Deployment approval granted.

## Sign-off Record
Reviewer Name:
Law Firm / Role:
Review Date:
Approved Version Date:
Blocking Issues Remaining:
Final Decision: APPROVED / CHANGES REQUIRED
