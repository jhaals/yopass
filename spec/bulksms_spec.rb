require 'yopass/sms_provider/bulksms'
require 'spec_helper'

describe 'bulksms' do

  it 'should send sms' do
    sms = Bulksms.new(
      'username' => 'foobar',
      'password' => '123',
      'sender' => 'YoPass')
    allow_any_instance_of(Bulksms).to receive(:send).and_return true
    expect(sms.send('467022123', 'decryption_key')).to be true
  end
end
