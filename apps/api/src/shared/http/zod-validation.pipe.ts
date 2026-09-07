import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Validates a request payload against a zod schema at the HTTP boundary
 * (`SPEC.md` §Project Structure lists `shared/http/` for exactly this).
 *
 * Constructed with the schema and applied per-parameter:
 *
 *   @Body(new ZodValidationPipe(registerRequestSchema)) body: RegisterRequest
 *
 * On failure it throws a 400 carrying the field *paths* and messages but never
 * the submitted *values* -- a validation error that echoed `password` back
 * would copy a secret into logs and proxy caches. The parsed (and defaulted /
 * normalised) value is what flows on to the handler.
 */
export class ZodValidationPipe<TOutput> implements PipeTransform {
  constructor(private readonly schema: ZodType<TOutput>) {}

  transform(value: unknown): TOutput {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    return result.data;
  }
}
