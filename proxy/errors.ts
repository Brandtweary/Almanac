export class AdmissionError extends Error {
  constructor(public code: string, public status = 503) { super(code); }
}
