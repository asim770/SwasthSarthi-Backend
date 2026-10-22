export class AuthorizationError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode = 403, code = "AUTHORIZATION_DENIED") {
    super(message);
    this.name = "AuthorizationError";
    this.statusCode = statusCode;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class UnauthenticatedError extends AuthorizationError {
  constructor(message = "Authentication session required.") {
    super(message, 401, "UNAUTHENTICATED");
    this.name = "UnauthenticatedError";
  }
}

export class ForbiddenError extends AuthorizationError {
  constructor(message = "Access forbidden for current principal role or scope.") {
    super(message, 403, "FORBIDDEN");
    this.name = "ForbiddenError";
  }
}

export class ConsentRequiredError extends AuthorizationError {
  constructor(
    message = "Active electronic consent required to access patient clinical record."
  ) {
    super(message, 403, "CONSENT_REQUIRED_OR_INVALID");
    this.name = "ConsentRequiredError";
  }
}

export class NotFoundError extends AuthorizationError {
  constructor(message = "Requested resource not found.") {
    super(message, 404, "NOT_FOUND");
    this.name = "NotFoundError";
  }
}

export class InvalidQueryError extends AuthorizationError {
  constructor(message = "Invalid query parameter or forbidden operator.") {
    super(message, 400, "INVALID_QUERY_PARAMETER");
    this.name = "InvalidQueryError";
  }
}
