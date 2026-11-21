import LegalPage, { Section } from './legal/LegalPage';

export default function PrivacyPolicy() {
  return (
    <LegalPage title="Privacy Policy" updated="November 2026">
      <p>I Was Here lets you draw on 360° photos of real places, together with whoever else is there. There are no accounts: we never ask for your name, email or password.</p>

      <Section heading="What we handle">
        <ul style={{ paddingLeft: 20, margin: 0 }}>
          <li><strong>A random device ID</strong>, created on your device and stored there. It keeps track of your ink and helps us stop abuse. It isn't linked to who you are.</li>
          <li><strong>Your drawings and cursor</strong>, sent live to other people looking at the same place. Our server keeps a place's drawings in memory only while someone is viewing it, then discards them. We don't save them.</li>
          <li><strong>Your IP address</strong>, which our server sees whenever your device connects, as with any website. We don't keep access logs.</li>
        </ul>
      </Section>

      <Section heading="Other services">
        <p style={{ margin: 0 }}>The satellite map is provided by Esri. To show it, your device loads map images directly from Esri, so Esri receives your IP address under its own privacy policy. Photos, depth data and live drawing all come from our own server.</p>
      </Section>

      <Section heading="What we don't do">
        <p style={{ margin: 0 }}>No accounts, no emails, no ads, no analytics or tracking, and we never sell data.</p>
      </Section>

      <Section heading="Your choices">
        <p style={{ margin: 0 }}>Clearing this site's data in your browser, or deleting the app, removes your device ID and ink. Questions or requests: <a href="mailto:markotsymbaluk@gmail.com" style={{ color: '#007aff' }}>markotsymbaluk@gmail.com</a>.</p>
      </Section>

      <Section heading="Changes">
        <p style={{ margin: 0 }}>If this policy changes, we'll update this page and the date above.</p>
      </Section>
    </LegalPage>
  );
}
