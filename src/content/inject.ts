import { TWX_GRAPHQL_MESSAGE_SOURCE, TWX_GRAPHQL_MESSAGE_TYPE } from '../modules/twitter/constants';

// Runs in the page's MAIN world at document_start.
// Patches fetch + XHR to forward X GraphQL responses to the isolated content script via postMessage.

(() => {
  const TARGET_OPS = [
	'TweetResultByRestId',
	'TweetResultsByRestIds',
	'TweetDetail',
	'HomeTimeline',
	'HomeLatestTimeline',
	'UserTweets',
	'UserTweetsAndReplies',
	'UserMedia',
	'Likes',
	'Bookmarks',
	'SearchTimeline',
	'ListLatestTweetsTimeline',
  ];

  const matchesTarget = (url: string) =>
	url.includes('/graphql/') && TARGET_OPS.some((op) => url.includes(`/${op}`));

  const forward = (url: string, data: unknown) => {
	window.postMessage({ source: TWX_GRAPHQL_MESSAGE_SOURCE, type: TWX_GRAPHQL_MESSAGE_TYPE, url, data }, '*');
  };

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

