# Privacy

LA2L (Lloyd's App2Live) brings sounds from apps into Ableton Live through a server at lloydstellar.nl. This page says what that server keeps, why, and for how long. LA2L is made by Erik Griffioen, Jhr van Sypesteynlaan 7, 1231 XL Loosdrecht, the Netherlands. Write to him there, or through https://lloydstellar.nl/contact.html, to see what the server keeps about you, or to have it removed.

## What the server keeps

**Your computer, when you pair it.** The name of the computer (such as "STUDIO-PC"), a random id that LA2L made for it, the version of LA2L and the operating system, and when it last called the server. The apps you pair with see the name, so you know which computer you send to. The server keeps this while the computer is paired, and removes it 30 days after you unpair. A test receiver, which developers use instead of Live, is removed after 7 days without a call.

**The apps you pair.** The name of each app, the id the app gives itself, which version of the LA2L software it uses, and when it paired and last called. LA2L shows the name in Live ("Paired with Web808"). Kept while the app is paired, and removed 30 days after it is unpaired.

**What you send.** The sound files, and their description: the title, the names of the sounds, their tempo. The files and their description wait until you click Import in Live and are deleted right after, or 24 hours after they were sent if you never import them. Then the server keeps only the title, the names of the sounds and whether each one arrived, for 7 days, so the app can show what is in Live.

**Tokens.** The server keeps only a hash of each token, except while a computer pairs: then its token waits as it is until LA2L in Live has picked it up, at most about ten minutes, and a minute longer. A nightly backup made in those minutes holds it too.

**IP addresses.** To stop abuse, the server counts calls per IP address. Those counts live only in its memory and are gone within the hour. To limit how much one address can store, the server keeps a hash of the address with each package while it has files; the key of that hash also lives only in memory, so after a restart nobody can tell the address from the hash.

**The log.** Every call is written to a log with the time, the IP address, what was asked, the answer, the number the server gave the computer or app that asked, and the name and version of the app's LA2L software when the app sends them. The log is for finding faults and abuse. The running server keeps the newest 50 MB of it. When the server is updated, the log so far is saved on the server for 30 days. The web server of lloydstellar.nl keeps its own log of every visit, with the IP address, for 14 days.

**Backups.** Every night the server makes a copy of its database (computers, apps and descriptions, never sound files). The newest 30 copies are kept, so something you removed can stay in a copy for up to 30 days.

## What it does not do

No cookies, no tracking, no analytics, no advertising. Nothing is sold or passed on to anyone. The pages of LA2L keep their pairing in your browser (`localStorage`); it leaves the browser only as the token in calls to this server.

The server runs on a VPS at TransIP, in the Netherlands. Erik Griffioen runs it.

## Why

Pairing, sending and importing are the service you ask for when you pair an app with LA2L (GDPR article 6(1)(b)). The log, the counts per address and the backups are there to keep that service working and safe (GDPR article 6(1)(f)).

## Your rights

You may ask to see what the server keeps about you, to have it corrected or removed, and you may complain to the Autoriteit Persoonsgegevens, the Dutch data protection authority. Unpairing in Live removes your computer and its apps from the server within 30 days.

Last changed on 18 October 2026.
