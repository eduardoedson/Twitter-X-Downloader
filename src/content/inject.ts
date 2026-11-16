import {
	TWX_GRAPHQL_MESSAGE_SOURCE,
	TWX_GRAPHQL_MESSAGE_TYPE,
	TWX_GRAPHQL_REPLAY_TYPE,
} from '../modules/twitter/constants';

// Runs in the page's MAIN world at document_start.
// Patches fetch + XHR to forward X GraphQL responses to the isolated content script via postMessage.

(() => {
	const capturedResponses: Array<{ url: string; data: unknown }> = [];
	const MAX_CAPTURED_RESPONSES = 30;
	let receiverReady = false;

	// Operation names change frequently. Capturing every GraphQL response is more
	// reliable than maintaining an allowlist, and the isolated script only retains
	// objects that the tweet parser recognizes as downloadable media.
	const matchesTarget = (url: string) =>
		url.includes('/graphql/') || url.includes('/i/api/2/timeline/');

  const forward = (url: string, data: unknown) => {
	if (!receiverReady) {
		capturedResponses.push({ url, data });
		if (capturedResponses.length > MAX_CAPTURED_RESPONSES) capturedResponses.shift();
	}
	window.postMessage({ source: TWX_GRAPHQL_MESSAGE_SOURCE, type: TWX_GRAPHQL_MESSAGE_TYPE, url, data }, '*');
  };

	// Keep a small replay buffer in case browser scheduling lets an early profile
	// response finish before the isolated-world listener announces that it is ready.
	window.addEventListener('message', (event) => {
		if (event.source !== window || event.origin !== window.location.origin) return;
		const message = event.data as { source?: string; type?: string } | undefined;
		if (message?.source !== TWX_GRAPHQL_MESSAGE_SOURCE || message.type !== TWX_GRAPHQL_REPLAY_TYPE) return;
		receiverReady = true;
		for (const response of capturedResponses) {
			window.postMessage(
				{
					source: TWX_GRAPHQL_MESSAGE_SOURCE,
					type: TWX_GRAPHQL_MESSAGE_TYPE,
					url: response.url,
					data: response.data,
				},
				'*',
			);
		}
		capturedResponses.length = 0;
	});

  const origFetch = window.fetch.bind(window);
  window.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit) {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
	const p = origFetch(input, init);
	if (matchesTarget(url)) {
	  p.then((response) => {
		response
		  .clone()
		  .json()
		  .then((data) => forward(url, data))
		  .catch(() => {});
	  }).catch(() => {});
	}
	return p;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(
	this: XMLHttpRequest & { __twxUrl?: string },
	_method: string,
	url: string | URL,
  ) {
	this.__twxUrl = typeof url === 'string' ? url : url.href;
	// The original `open` is overloaded; using `apply` with arguments keeps the original behavior.
	// eslint-disable-next-line prefer-rest-params
	return (origOpen as (...a: unknown[]) => void).apply(this, arguments as unknown as unknown[]);
  };

  XMLHttpRequest.prototype.send = function patchedSend(
	this: XMLHttpRequest & { __twxUrl?: string },
	body?: Document | XMLHttpRequestBodyInit | null,
  ) {
	const url = this.__twxUrl;
	if (url && matchesTarget(url)) {
	  this.addEventListener('load', () => {
		try {
		  const text = typeof this.responseText === 'string' ? this.responseText : '';
		  if (!text) return;
		  const data = JSON.parse(text);
		  forward(url, data);
		} catch {
		  /* ignore non-JSON */
		}
	  });
	}
	return origSend.call(this, body as any);
  };
})();

