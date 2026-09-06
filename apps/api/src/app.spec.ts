import { Test } from '@nestjs/testing';

import { AppController } from './app.controller';
import { AppService } from './app.service';

/**
 * The smoke test for the unit project. It is deliberately thin: its job is to
 * prove the toolchain -- ts-jest, decorator metadata, Nest's DI container --
 * actually works, so that a later failure in a real test means the code is
 * wrong rather than the setup.
 */
describe('AppController', () => {
  let controller: AppController;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    controller = moduleRef.get(AppController);
  });

  it('resolves through the DI container', () => {
    // Resolution is the real assertion here: emitDecoratorMetadata is what lets
    // Nest see the AppService constructor parameter, and when it is missing the
    // controller is constructed with an undefined dependency rather than
    // failing to compile.
    expect(controller).toBeInstanceOf(AppController);
  });

  it('reports the process as healthy', () => {
    expect(controller.getHealth()).toEqual({ status: 'ok' });
  });
});
