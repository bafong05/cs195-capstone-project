function reportActivity() {
  chrome.runtime.sendMessage({
    type: "userActivity"
  });
}

["mousemove","scroll","keydown","click"].forEach(event => {
  document.addEventListener(event, reportActivity, { passive:true });
});

function detectVideo() {

  const videos = document.querySelectorAll("video");

  for (const v of videos) {

    const rect = v.getBoundingClientRect();
    const area = rect.width * rect.height;

    if (
      !v.paused &&
      !v.ended &&
      v.currentTime > 0 &&
      area > 200000 &&
      document.visibilityState === "visible"
    ) {
      chrome.runtime.sendMessage({
        type:"videoStatus",
        playing:true
      });
      return;
    }
  }

  chrome.runtime.sendMessage({
    type:"videoStatus",
    playing:false
  });
}

setInterval(detectVideo, 5000);