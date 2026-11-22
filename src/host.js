export class ServeHost {
  fetch() {
    return new Response('not found', { status: 404 });
  }
}
