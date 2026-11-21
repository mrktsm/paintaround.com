import LegalPage, { Section } from './legal/LegalPage';

export default function PrivacyPolicy() {
  return (
    <LegalPage title="Privacy Policy" updated="November 21, 2026">
      <p>This Privacy Policy explains what information paintaround at paintaround.com (the "Service") handles when you use it. In short: there are no accounts, we don't track you, and drawings aren't stored.</p>

      <Section n={1} heading="No accounts">
        <p>You never sign up. We don't ask for your name, email address, phone number or password, and we don't use sign-in services.</p>
      </Section>

      <Section n={2} heading="What we handle">
        <ul>
          <li><strong>A random device ID.</strong> Your device creates it and keeps it. It lets us keep track of your ink and helps us stop abuse. It isn't linked to who you are.</li>
          <li><strong>Your drawings and cursor.</strong> While you're in a place, your cursor position, brush and drawings are sent to our server and passed on live to the other people viewing that place, along with a cursor colour.</li>
          <li><strong>Which place you're viewing</strong>, so we can connect you with others viewing the same place.</li>
          <li><strong>Your IP address</strong>, which our server receives whenever your device connects, as with any website.</li>
        </ul>
      </Section>

      <Section n={3} heading="How long we keep it">
        <p>A place's drawings are kept only in our server's memory while someone is viewing that place, and are discarded once everyone has left. We don't save drawings, and we don't keep access logs of IP addresses. Your device ID stays on your device.</p>
      </Section>

      <Section n={4} heading="Who sees it">
        <ul>
          <li><strong>Other people viewing the same place</strong> see your cursor and drawings live. They don't see your device ID or IP address.</li>
          <li><strong>Esri</strong> provides the satellite map. To show it, your device loads map images directly from Esri, so Esri receives your IP address under its own privacy policy.</li>
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
