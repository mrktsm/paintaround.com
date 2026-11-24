import LegalPage, { Section } from './legal/LegalPage';

export default function PrivacyPolicy() {
  return (
    <LegalPage title="Privacy Policy" updated="November 23, 2026">
      <p>This Privacy Policy explains what information paintaround at paintaround.com (the "Service") handles when you use it. In short: there are no accounts, we don't track you, and drawings are kept only temporarily. New drawings may be checked automatically for harmful content.</p>

      <Section n={1} heading="No accounts">
        <p>You never sign up. We don't ask for your name, email address, phone number or password, and we don't use sign-in services.</p>
      </Section>

      <Section n={2} heading="What we handle">
        <ul>
          <li><strong>A random device ID.</strong> Your device creates it and keeps it. It lets us keep track of your ink and helps us stop abuse. It isn't linked to who you are.</li>
          <li><strong>Your drawings and cursor.</strong> While you're in a place, your cursor position, brush and drawings are sent to our server and passed on live to the other people viewing that place, along with a cursor colour. Finished drawings stay on the place for people who come later and appear in its preview pictures. They aren't linked to you.</li>
          <li><strong>Pictures of new drawings, for moderation.</strong> To keep hateful, sexual, threatening or other harmful drawings off the Service, a picture of your new drawing and the part of the place around it may be checked automatically by an AI model. Anything you draw or write there, including personal information, is part of that picture, so please don't draw anything private.</li>
          <li><strong>Which place you're viewing</strong>, so we can connect you with others viewing the same place.</li>
          <li><strong>Your IP address</strong>, which our server receives whenever your device connects, as with any website.</li>
        </ul>
      </Section>

      <Section n={3} heading="How long we keep it">
        <p>Drawings are kept only in our server's memory, never written to disk, and are cleared whenever the server restarts (or earlier if space runs short). If a drawing is flagged, our server also keeps it, with the reason and a picture, in memory for up to 24 hours. The companies that help with moderation may keep the pictures they receive for a limited time (see below). We don't keep access logs of IP addresses. Your device ID stays on your device.</p>
      </Section>

      <Section n={4} heading="Who sees it">
        <ul>
          <li><strong>Other people</strong> see your cursor live, and your drawings both live and afterwards, in the place and its preview pictures. They don't see your device ID or IP address.</li>
          <li><strong>Esri</strong> provides the satellite map. To show it, your device loads map images directly from Esri, so Esri receives your IP address under its own privacy policy.</li>
          <li><strong>Google</strong> (Gemini API) receives the moderation pictures described above to check them, and handles them under its own terms. We don't send it your device ID or IP address.</li>
          <li><strong>ntfy.sh</strong>, a notification service, passes an alert to us when a drawing is flagged: the pictures, the place and the reason. We don't send it your device ID or IP address.</li>
          <li><strong>Our hosting provider</strong> runs the server that delivers the Service.</li>
        </ul>
        <p>We don't sell or rent information, and we don't share it with advertisers or data brokers.</p>
      </Section>

      <Section n={5} heading="Storage on your device">
        <p>The Service uses your browser's local storage, not cookies, to remember things on your device: your device ID and ink, the colour you picked for each tool, places you've recently opened, and whether you've seen the tips. This stays on your device.</p>
      </Section>

      <Section n={6} heading="No tracking">
        <p>No ads, no analytics, no tracking pixels, and no third-party trackers.</p>
      </Section>

      <Section n={7} heading="Your choices">
        <p>You can clear this site's data in your browser settings at any time. That removes your device ID, ink and everything else stored on your device.</p>
      </Section>

      <Section n={8} heading="Children">
        <p>The Service isn't directed at children under 13, and we don't knowingly collect information from them.</p>
      </Section>

      <Section n={9} heading="Changes">
        <p>If this policy changes, we'll update this page and the date at the top.</p>
      </Section>

      <Section n={10} heading="Contact">
        <p>Questions or requests: <a href="mailto:markotsymbaluk@gmail.com">markotsymbaluk@gmail.com</a>.</p>
      </Section>
    </LegalPage>
  );
}
