require 'yopass/sms_provider/bulksms'
require 'spec_helper'

describe 'bulksms' do

  it 'should send sms' do
    sms = Bulksms.new(
      'username' => 'foobar',
      'password' => '123',
      'sender' => 'YoPass')
    Bulksms.any_instance.stub(:send).and_return(true)
    sms.send('467022123', 'decryption_key').should == true
  end
end
