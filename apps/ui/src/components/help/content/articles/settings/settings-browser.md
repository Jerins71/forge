**Settings → Browser** manages the browser on the machine chosen at the top of Settings. Each project has its own browser profile on each machine, so sign-ins stay with that project.

## Browser on this machine

Shows whether the machine's browser is ready. A machine installs its browser the first time an agent needs one; **Set up** does it now, and **Try again** retries a setup that failed and shows why.

## Browser profile

- **Project** chooses the profile you're managing.
- **Sign in once…** opens a site in that project's Browser panel. Sign in there, and agents in the project stay signed in.

## Signed-in sites

Lists the sites the project's browser has sign-ins for, with how many cookies each has and when they were added. **Forget** asks first, then signs the project out of that site.

## Import from Chrome

Brings sign-ins for the sites you choose from your own Chrome. Passwords, history and the rest of your Chrome profile are never copied.

1. **Choose where to read from.**
   - *Chrome, while it's open*: open `chrome://inspect/#remote-debugging` in Chrome and turn on remote debugging. When you continue, Chrome asks whether to allow the connection; choose **Allow**. You can turn remote debugging off again afterwards.
   - *Chrome's cookie file* (macOS and Linux): Chrome can stay closed. macOS asks whether Forge may use **Chrome Safe Storage** in your Keychain; enter your login password and choose **Allow**. On Linux your keyring may ask to unlock. If macOS blocks access to Chrome's files, open **System Settings › Privacy & Security › Files & Folders** from the link shown and allow Forge, then try again.
2. **Choose sites.** Sites are listed most recently used first, with their cookie counts. Nothing is selected for you; search to find a site. The list is only valid for a few minutes.
3. **Confirm.** Check which sites go into which project on which machine. Agents in that project will be signed in to them as you. **Also send these sites to another machine** is off unless you turn it on; the sites are then sent once over your paired connection to the project you choose there.
4. **Result.** Lists what was imported and any sites that were skipped, with the reason.

Cookie values are never shown, logged, or saved in conversations or artifacts.
