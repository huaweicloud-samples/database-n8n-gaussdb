import type { Event } from '@sentry/node';

export type ErrorLevel = 'fatal' | 'error' | 'warning' | 'info';

export type ErrorTags = NonNullable<Event['tags']>;

/** Options forwarded to the native `Error` constructor (ES2022). */
export type ErrorOptions = {
	cause?: Error;
};

export type ReportingOptions = {
	/** Whether the error should be reported to Sentry */
	shouldReport?: boolean;
	/** Whether the error log should be logged (default to true) */
	shouldBeLogged?: boolean;
	level?: ErrorLevel;
	tags?: ErrorTags;
	extra?: Event['extra'];
	executionId?: string;
};
