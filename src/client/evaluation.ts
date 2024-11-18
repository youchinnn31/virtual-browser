addEventListener("open", () => {
  const clickEvent = new Event("click");
  const urlButton = document.getElementById("url-button") as HTMLButtonElement;
  urlButton.dispatchEvent(clickEvent);
});
