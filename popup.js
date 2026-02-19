let showingDetails = false;

chrome.storage.local.get(["sessions"], (result) => {
  const sessions = result.sessions || [];

  document.getElementById("totalSessions").innerText = sessions.length;

  if (sessions.length === 0) return;

  let totalDuration = 0;
  let longest = 0;
  const siteCounts = {};

  sessions.forEach((session) => {
    const duration = (session.end - session.start) / 60000;
    totalDuration += duration;
    longest = Math.max(longest, duration);

    session.sites.forEach((site) => {
      siteCounts[site] = (siteCounts[site] || 0) + 1;
    });
  });

  document.getElementById("avgSession").innerText =
    Math.round(totalDuration / sessions.length);
  document.getElementById("longestSession").innerText =
    Math.round(longest);

  const topSites = Object.entries(siteCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  const list = document.getElementById("topSites");
  list.innerHTML = "";
  topSites.forEach(([site, count]) => {
    const li = document.createElement("li");
    li.innerText = `${site} (${count})`;
    list.appendChild(li);
  });

  // DETAILS TOGGLE
  const button = document.getElementById("toggleDetails");
  const container = document.getElementById("sessions");

  button.addEventListener("click", () => {
    showingDetails = !showingDetails;
    container.style.display = showingDetails ? "block" : "none";
    button.innerText = showingDetails
      ? "Hide Session Details"
      : "View Session Details";

    if (showingDetails) renderSessions(sessions, container);
  });
});

function renderSessions(sessions, container) {
  container.innerHTML = "";

  sessions.forEach((session, index) => {
    const div = document.createElement("div");
    div.className = "session";

    const start = new Date(session.start).toLocaleTimeString();
    const end = new Date(session.end).toLocaleTimeString();
    const duration = Math.round((session.end - session.start) / 60000);

    div.innerHTML = `
      <strong>Session ${index + 1}</strong><br>
      ${start} → ${end} (${duration} min)
      <div class="details">
        ${session.sites.join(" → ")}
      </div>
    `;

    container.appendChild(div);
  });
}
