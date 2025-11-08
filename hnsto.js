// Define a function to handle node removal based on criteria
function removeNodes(node) {
  if (node.matches('a[href="https://www.hns.to"]')) {
    node.remove();
  } else if (node.matches('div[style*="background-color: rgb(241, 0, 19);"]')) {
    node.parentElement.remove();
  } else if (node.matches('div[style="margin: 0; padding: 0; height: 75px"]')) {
    node.remove();
  }
}

// Remove elements that are already present
document.querySelectorAll('a[href="https://www.hns.to"], div[style*="background-color: rgb(241, 0, 19);"], div[style="margin: 0; padding: 0; height: 75px"]').forEach(removeNodes);

// Initialize MutationObserver to handle future additions
const observer = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    const addedNodes = mutation.addedNodes;
    addedNodes.forEach((node) => {
      if (node.nodeType === 1) {
        removeNodes(node);
      }
    });
  });
});

// Observe specific parts of the DOM where additions might occur
observer.observe(document.body, { childList: true, subtree: true });
