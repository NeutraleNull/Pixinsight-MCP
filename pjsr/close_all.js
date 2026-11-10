#engine v8
// Only ever sent to an instance this server owns, right before it is stopped. With modified images
// open, --terminate asks for confirmation, and automation mode answers with the default: No.
for ( const window of ImageWindow.windows )
   window.forceClose();
