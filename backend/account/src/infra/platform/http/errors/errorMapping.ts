import type { FastifyError, FastifyInstance } from 'fastify';

type ErrorClass = abstract new (...args: never[]) => Error;

export interface ErrorMapping {
  readonly error: ErrorClass;
  readonly statusCode: number;
  readonly code: string;
}

export const registerErrorMapping = (app: FastifyInstance, mappings: readonly ErrorMapping[]): void => {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const mapping = mappings.find((candidate) => error instanceof candidate.error);
    if (mapping) return reply.status(mapping.statusCode).send({ error: mapping.code, message: error.message });
    if (error.validation) return reply.status(422).send({ error: 'invalidRequest', message: error.message });

    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: 'internalError' });
  });
};
