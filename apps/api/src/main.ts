import 'reflect-metadata';

import fastifyCookie from '@fastify/cookie';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';

import { AppModule } from './app.module';

/**
 * The in-container port is fixed. compose-dev.yaml publishes it to the host as
 * APP_HOST_PORT, so only the host-facing side is configurable -- which is the
 * side that actually collides with other software on a developer's machine.
 */
const PORT = 3000;

/** Fastify binds to loopback by default, which a published port cannot reach. */
const HOST = '0.0.0.0';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  // `POST /auth/refresh` reads the WEB refresh token from the `refresh_token`
  // cookie; this plugin is what populates `request.cookies`. Registered with no
  // secret -- the cookie is never signed here, only read (ADR 0003).
  await app.register(fastifyCookie);

  // Without this, SIGTERM kills the process outright and no provider's
  // onModuleDestroy runs -- the database pool is dropped rather than closed,
  // which on a rolling deploy leaves connections to time out server-side.
  app.enableShutdownHooks();

  await app.listen(PORT, HOST);
}

void bootstrap();
