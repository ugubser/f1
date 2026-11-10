import {signIn, TokenStore, AuthError} from '../f1-auth.mjs';
import {ApiError, invalid, objectBody} from '../api-errors.mjs';

// A generation prevents a cancelled or superseded login from saving a token.
export class AccountService {
  constructor({tokens = new TokenStore(), live, login = signIn} = {}) {
    this.tokens = tokens; this.live = live; this.signIn = login; this.generation = 0; this.busy = false; this.commit = Promise.resolve();
  }
  async status() {
    const auth = this.live ? await this.live.authStatus() : await this.tokens.status();
    return {...auth, signingIn: this.busy};
  }
  async login(body) {
    objectBody(body, ['email', 'password']);
    if (typeof body.email !== 'string' || !body.email.trim() || body.email.length > 320 || typeof body.password !== 'string' || !body.password || body.password.length > 4096) throw invalid('Enter an email and password.');
    if (this.busy) throw new ApiError(409, 'LOGIN_IN_PROGRESS', 'A sign-in is already in progress.');
    this.busy = true; const generation = ++this.generation;
    const controller = new AbortController(); this.controller = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]);
    try {
      const token = await this.signIn(body.email.trim(), body.password, {signal});
      const save = this.commit.then(async () => {
        if (generation !== this.generation || signal.aborted) throw new ApiError(409, 'LOGIN_CANCELLED', 'Sign-in was cancelled or timed out.');
        this.live?.disconnect();
        await this.tokens.save(token);
        if (this.live) this.live.rejectedDigest = null;
      });
      this.commit = save.catch(() => {}); await save;
      if (generation !== this.generation || signal.aborted) throw new ApiError(409, 'LOGIN_CANCELLED', 'Sign-in was cancelled.');
      this.busy = false;
      const status = await this.status();
      if (generation !== this.generation) throw new ApiError(409, 'LOGIN_CANCELLED', 'Sign-in was cancelled.');
      return status;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // Never return raw upstream errors or bodies, including credential echoes.
      throw new ApiError(422, 'F1_LOGIN_FAILED', generation !== this.generation ? 'Sign-in was cancelled.' : error instanceof AuthError ? error.message : 'F1 sign-in could not be completed.');
    } finally { body.password = ''; if (generation === this.generation) this.busy = false; }
  }
  async logout() {
    this.generation++; this.busy = false; this.controller?.abort(); this.live?.disconnect();
    const clear = this.commit.then(() => this.tokens.clear()); this.commit = clear.catch(() => {}); await clear;
    return this.status();
  }
  close() { this.generation++; this.controller?.abort(); }
}
