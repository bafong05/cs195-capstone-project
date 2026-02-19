chrome.tabs.onActivated.addListener(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url) {
    logVisit(tab.url);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.active && tab.url) {
    logVisit(tab.url);
  }
});

function logVisit(url) {
  const site = new URL(url).hostname;
  const timestamp = Date.now();

  chrome.storage.local.get(["visits"], (result) => {
    const visits = result.visits || [];
    visits.push({ site, timestamp });

    const sessions = groupIntoSessions(visits);

    chrome.storage.local.set({ visits, sessions });
    console.log("Sessions:", sessions.length);
  });
}

function groupIntoSessions(visits) {
  const sessions = [];
  let currentSession = null;

  for (let i = 0; i < visits.length; i++) {
    const visit = visits[i];

    if (!currentSession) {
      currentSession = {
        start: visit.timestamp,
        end: visit.timestamp,
        sites: [visit.site]
      };
    } else {
      const gap = visit.timestamp - currentSession.end;

      if (gap > 10 * 60 * 1000) {
        sessions.push(currentSession);
        currentSession = {
          start: visit.timestamp,
          end: visit.timestamp,
          sites: [visit.site]
        };
      } else {
        currentSession.end = visit.timestamp;
        currentSession.sites.push(visit.site);
      }
    }
  }

  if (currentSession) sessions.push(currentSession);
  return sessions;
}
