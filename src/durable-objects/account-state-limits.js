// These partitions share one 128 KiB value; leave space for JSON and ledger metadata.
export const ACCOUNT_STATE_LIMITS = Object.freeze({
  summaryBytes: 50000, ledgerBytes: 16000, holdBytes: 8000,
  activityBytes: 10000, holdsWithActivityBytes: 4000, holdUpdateHeadroom: 128
});
