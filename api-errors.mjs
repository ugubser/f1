export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const invalid = message => new ApiError(400, 'INVALID_REQUEST', message);
export function objectBody(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Expected a JSON object.');
  if (Object.keys(value).some(key => !allowed.includes(key))) throw invalid('Unknown request field.');
  return value;
}
export function positiveId(value, name = 'raceId') {
  if (!/^\d{1,8}$/.test(String(value)) || +value < 1) throw invalid(`Invalid ${name}.`);
  return +value;
}
