document.addEventListener("click", function (event) {
  var button = event.target.closest && event.target.closest("button[data-prompt]");
  if (!button) return;
  event.preventDefault();
  var text = button.getAttribute("data-prompt");
  if (text && text.trim()) window.location.href = "doudou://prompt?text=" + encodeURIComponent(text);
});
