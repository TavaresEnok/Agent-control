/** Push-only worker. It must not handle fetch or touch the cache, so the panel never shows a stale API response. */
export const panelServiceWorkerSource=`self.addEventListener('push', function (event) {
  var title = 'Agent Control';
  var body = '';
  var url = '/';
  try {
    var data = event.data ? event.data.json() : {};
    if (data && typeof data.title === 'string' && data.title) title = data.title;
    if (data && typeof data.body === 'string') body = data.body;
    if (data && typeof data.url === 'string' && data.url.charAt(0) === '/') url = data.url;
  } catch (ignore) {}
  event.waitUntil(self.registration.showNotification(title, {body: body, icon: '/pwa/icon-192.png', data: {url: url}}));
});
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var target = event.notification.data && event.notification.data.url;
  if (typeof target !== 'string' || target.charAt(0) !== '/') target = '/';
  event.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(function (windows) {
    var index;
    for (index = 0; index < windows.length; index++) {
      var page = windows[index];
      if (new URL(page.url).origin !== self.location.origin) continue;
      var opened = typeof page.navigate === 'function' ? page.navigate(target) : Promise.resolve(page);
      return opened.then(function (client) { return (client || page).focus(); });
    }
    return self.clients.openWindow(target);
  }));
});
`;

export function panelServiceWorkerResponse(){
 return new Response(panelServiceWorkerSource,{headers:{'content-type':'text/javascript; charset=utf-8','cache-control':'no-cache','x-content-type-options':'nosniff'}});
}
