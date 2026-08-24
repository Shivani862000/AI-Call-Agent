'use strict';

class WebmasterError extends Error {
  constructor({ status = 403, code = 'WEBMASTER_FORBIDDEN', message = 'Webmaster access is not permitted', fieldErrors = {} } = {}) {
    super(message);
    this.name = 'WebmasterError';
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }

  toResponse() {
    return {
      status: this.status,
      code: this.code,
      message: this.message,
      error: this.message,
      fieldErrors: this.fieldErrors
    };
  }
}

function forbidden(code, message) {
  return new WebmasterError({
    status: 403,
    code,
    message: message || 'Webmaster access is not permitted'
  });
}

module.exports = { WebmasterError, forbidden };
